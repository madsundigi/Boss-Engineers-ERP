import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { dispatchRouter } from '../src/modules/dispatch/dispatch.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts dispatchRouter at /api/dispatch exactly as the composition root
 * does (createApp wires `app.use('/api/dispatch', dispatchRouter(pool))`); here we
 * mount a minimal equivalent so the module is testable independently of app.ts.
 *
 * Multi-gate release: STORES creates/prepares + releases (DISPATCH.VCEX); QC
 * clears the quality gate and FINANCE the commercial gate (both DISPATCH.APPROVE);
 * release is blocked until BOTH gates are open.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/dispatch', dispatchRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Dispatch API (integration) — create, multi-gate release, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let storesUser: number;
  let qcUser: number;
  let financeUser: number;
  let salesUser: number;
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
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);
    qcUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='qc_user'`)).user_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    // Master data the dispatch references (project_id + customer_id are NOT NULL FKs
    // on log.dispatch and are not in the base seed). The test connects as the owning
    // superuser, so RLS does not filter these inserts. A pm_user_id is required.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-DSP-TEST', 'Dispatch Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, storesUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates a dispatch (201) with an auto-generated DSP number, in DRAFT', async () => {
    const res = await request(app).post('/api/dispatch').set(hdr(storesUser)).send({
      projectId, customerId,
      transporter: 'BlueDart Logistics',
    });
    // serials omitted (item ids are env-specific); create still succeeds with none.
    expect(res.status).toBe(201);
    expect(res.body.dispatchNo).toMatch(/^DSP\//);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.qualityClearedBy).toBeNull();
    expect(res.body.commercialClearedBy).toBeNull();
    createdId = res.body.dispatchId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without DISPATCH.CREATE (sales -> 403, view-only)', async () => {
    const res = await request(app).post('/api/dispatch').set(hdr(salesUser)).send({ projectId, customerId });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing required ids', async () => {
    const r1 = await request(app).post('/api/dispatch').set(hdr(storesUser)).send({ projectId });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/dispatch').set(hdr(storesUser))
      .send({ projectId, customerId, dispatchDate: 'not-a-date' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/dispatch');
    expect(res.status).toBe(401);
  });

  it('lists dispatches (200) and allows the SALES view-only role to read', async () => {
    const res = await request(app).get('/api/dispatch?status=DRAFT').set(hdr(storesUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asSales = await request(app).get('/api/dispatch').set(hdr(salesUser));
    expect(asSales.status).toBe(200);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/dispatch/${createdId}`).set(hdr(storesUser));
    expect(ok.status).toBe(200);
    expect(ok.body.projectId).toBe(projectId);
    const no = await request(app).get('/api/dispatch/99999999').set(hdr(storesUser));
    expect(no.status).toBe(404);
  });

  it('BLOCKS release before both gates are cleared (409)', async () => {
    const res = await request(app).post(`/api/dispatch/${createdId}/release`).set(hdr(storesUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(409);
  });

  it('clears the quality gate as QC (DISPATCH.APPROVE)', async () => {
    const res = await request(app).post(`/api/dispatch/${createdId}/clear-quality`).set(hdr(qcUser))
      .send({ rowVersion: createdVersion, note: 'FAT passed' });
    expect(res.status).toBe(200);
    expect(res.body.qualityClearedBy).toBe(qcUser);
    expect(res.body.commercialClearedBy).toBeNull();
    createdVersion = res.body.rowVersion;
  });

  it('still BLOCKS release with only the quality gate cleared (409)', async () => {
    const res = await request(app).post(`/api/dispatch/${createdId}/release`).set(hdr(storesUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(409);
  });

  it('denies a clearance to a role without DISPATCH.APPROVE (sales -> 403)', async () => {
    const res = await request(app).post(`/api/dispatch/${createdId}/clear-commercial`).set(hdr(salesUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(403);
  });

  it('clears the commercial gate as FINANCE, then releases (200, status RELEASED)', async () => {
    const fin = await request(app).post(`/api/dispatch/${createdId}/clear-commercial`).set(hdr(financeUser))
      .send({ rowVersion: createdVersion, note: 'advance received' });
    expect(fin.status).toBe(200);
    expect(fin.body.commercialClearedBy).toBe(financeUser);

    // both gates now open — release succeeds (stores drives the shipment release).
    const rel = await request(app).post(`/api/dispatch/${createdId}/release`).set(hdr(storesUser))
      .send({ rowVersion: fin.body.rowVersion });
    expect(rel.status).toBe(200);
    expect(rel.body.status).toBe('RELEASED');

    // the release recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='DISPATCH' AND aggregate_id=$1 AND event_type='dispatch.released'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.dispatchNo).toMatch(/^DSP\//);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/dispatch').set(hdr(storesUser)).send({ projectId, customerId });
    expect(create.status).toBe(201);
    const id = create.body.dispatchId;
    // clear the quality gate once so the original version is now stale
    await request(app).post(`/api/dispatch/${id}/clear-quality`).set(hdr(qcUser))
      .send({ rowVersion: create.body.rowVersion });
    const stale = await request(app).post(`/api/dispatch/${id}/clear-commercial`).set(hdr(financeUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
