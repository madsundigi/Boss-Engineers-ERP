import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { failureRouter } from '../src/modules/failure/failure.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts failureRouter at /api/ncrs exactly as the composition root does
 * (createApp wires `app.use('/api/ncrs', failureRouter(pool))`); here we mount a
 * minimal equivalent so the module is testable independently of app.ts.
 *
 * 8D workflow: anyone on the floor (PRODUCTION/INSTALL/SERVICE/STORES) can raise an
 * NCR (NCR_CAPA.CREATE); recording the RCA + CAPA is QC's job (NCR_CAPA.EDIT); the
 * closure / effectiveness-verification gate is NCR_CAPA.APPROVE (QC). SALES has no
 * NCR_CAPA permission at all (used for the 403 cases, including on GET).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/ncrs', failureRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Failure Analysis API (integration) — NCR -> RCA -> CAPA -> CLOSE, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let qcUser: number;
  let productionUser: number;
  let salesUser: number;
  let installUser: number;
  let serviceUser: number;
  let storesUser: number;
  let projectId: number;
  let customerId: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    qcUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='qc_user'`)).user_id);
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    installUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='install_user'`)).user_id);
    serviceUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='service_user'`)).user_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);

    // An NCR does NOT require a project (project_id is nullable), but we seed one so
    // the create-with-project path is exercised. The test connects as the owning
    // superuser, so RLS does not filter these inserts. CUST-TEST comes from seed.sql.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-NCR-TEST', 'Failure Analysis Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, qcUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;
  let capaId: number;

  it('raises an NCR (201) as PRODUCTION with an auto-generated NCR number, in OPEN', async () => {
    const res = await request(app).post('/api/ncrs').set(hdr(productionUser)).send({
      source: 'PRODUCTION', projectId, severity: 'MAJOR',
    });
    expect(res.status).toBe(201);
    expect(res.body.ncrNo).toMatch(/^NCR\//);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.rca).toEqual([]);
    expect(res.body.capa).toEqual([]);
    createdId = res.body.ncrId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without NCR_CAPA.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/ncrs').set(hdr(salesUser)).send({ source: 'PRODUCTION' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing / invalid source', async () => {
    const r1 = await request(app).post('/api/ncrs').set(hdr(productionUser)).send({ projectId });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/ncrs').set(hdr(productionUser)).send({ source: 'NOT-A-SOURCE' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/ncrs');
    expect(res.status).toBe(401);
  });

  it('denies read to a role without NCR_CAPA.VIEW (sales -> 403 on GET)', async () => {
    const res = await request(app).get('/api/ncrs').set(hdr(salesUser));
    expect(res.status).toBe(403);
  });

  it('lists NCRs (200) and 404s an unknown id', async () => {
    const list = await request(app).get('/api/ncrs?status=OPEN&source=PRODUCTION').set(hdr(qcUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    const ok = await request(app).get(`/api/ncrs/${createdId}`).set(hdr(qcUser));
    expect(ok.status).toBe(200);
    expect(ok.body.projectId).toBe(projectId);
    expect(Array.isArray(ok.body.rca)).toBe(true);
    expect(Array.isArray(ok.body.capa)).toBe(true);
    const no = await request(app).get('/api/ncrs/99999999').set(hdr(qcUser));
    expect(no.status).toBe(404);
  });

  it('records an RCA as QC (advances OPEN -> RCA)', async () => {
    const res = await request(app).post(`/api/ncrs/${createdId}/rca`).set(hdr(qcUser))
      .send({ method: '5WHY', rootCause: 'Worn sealing face', rowVersion: createdVersion });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('RCA');
    expect(res.body.rca).toHaveLength(1);
    expect(res.body.rca[0].method).toBe('5WHY');
    createdVersion = res.body.rowVersion;
  });

  it('denies recording an RCA to a role without NCR_CAPA.EDIT (production -> 403)', async () => {
    const res = await request(app).post(`/api/ncrs/${createdId}/rca`).set(hdr(productionUser))
      .send({ method: '8D', rowVersion: createdVersion });
    expect(res.status).toBe(403);
  });

  it('records a CAPA as QC (advances RCA -> CAPA)', async () => {
    const res = await request(app).post(`/api/ncrs/${createdId}/capa`).set(hdr(qcUser))
      .send({ capaType: 'CORRECTIVE', action: 'Replace seal + revise torque spec', rowVersion: createdVersion });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CAPA');
    expect(res.body.capa).toHaveLength(1);
    capaId = res.body.capa[0].capaId;
    createdVersion = res.body.rowVersion;
  });

  it('BLOCKS close before the CAPA is verified (409)', async () => {
    const res = await request(app).post(`/api/ncrs/${createdId}/close`).set(hdr(qcUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(409);
  });

  it('verifies the CAPA, then closes the NCR as QC (200) emitting ncr.closed', async () => {
    const verify = await request(app).patch(`/api/ncrs/${createdId}/capa/${capaId}`).set(hdr(qcUser))
      .send({ status: 'VERIFIED', effectivenessCheck: 'Retested 10 units OK' });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('VERIFIED');

    const closed = await request(app).post(`/api/ncrs/${createdId}/close`).set(hdr(qcUser))
      .send({ rowVersion: createdVersion });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');

    // the close recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='NCR' AND aggregate_id=$1 AND event_type='ncr.closed'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.ncrNo).toMatch(/^NCR\//);
    expect(evt.rows[0].payload.source).toBe('PRODUCTION');
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/ncrs').set(hdr(productionUser)).send({ source: 'FAT' });
    expect(create.status).toBe(201);
    const id = create.body.ncrId;
    // record an RCA once so the original version is now stale
    await request(app).post(`/api/ncrs/${id}/rca`).set(hdr(qcUser))
      .send({ method: 'FISHBONE', rowVersion: create.body.rowVersion });
    const stale = await request(app).post(`/api/ncrs/${id}/capa`).set(hdr(qcUser))
      .send({ capaType: 'PREVENTIVE', action: 'x', rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });

  it('allows the other floor roles to raise an NCR (install / service / stores -> 201)', async () => {
    for (const [user, source] of [[installUser, 'INSTALL'], [serviceUser, 'WARRANTY'], [storesUser, 'GRN']] as const) {
      const res = await request(app).post('/api/ncrs').set(hdr(user)).send({ source });
      expect(res.status).toBe(201);
    }
  });
});
