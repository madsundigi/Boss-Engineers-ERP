import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { fatRouter } from '../src/modules/fat/fat.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts fatRouter at /api/fat exactly as the composition root does
 * (createApp wires `app.use('/api/fat', fatRouter(pool))`); here we mount a
 * minimal equivalent so the module is testable independently of app.ts.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/fat', fatRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('FAT API (integration) — lifecycle, result/sign-off, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let qcUser: number;
  let salesUser: number;
  let projectId: number;
  let protocolId: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  let createdId: number;
  let createdVersion: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    qcUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='qc_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    // Master data the FAT references (project_id + protocol_id are NOT NULL FKs on
    // qms.fat_execution and are not in the base seed). The test connects as the
    // owning superuser, so RLS does not filter these inserts.
    const customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-FAT-TEST', 'FAT Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, qcUser]);
    projectId = Number(proj.project_id);

    const proto = await one(
      `INSERT INTO qms.fat_protocol (company_id, protocol_code, protocol_name, test_type)
       VALUES ($1, 'PROTO-FAT-TEST', 'FAT Test Protocol', 'FAT')
       ON CONFLICT (protocol_code) DO UPDATE SET protocol_name = EXCLUDED.protocol_name
       RETURNING protocol_id`, [companyId]);
    protocolId = Number(proto.protocol_id);

    await pool.query(
      `INSERT INTO qms.fat_protocol_param (protocol_id, seq, param_name, spec_min, spec_max, uom)
       VALUES ($1, 1, 'Load Test', 0, 50, 'T')
       ON CONFLICT (protocol_id, seq) DO NOTHING`, [protocolId]);
  });

  afterAll(async () => { await pool.end(); });

  it('creates a FAT (201) with an auto-generated number', async () => {
    const res = await request(app).post('/api/fat').set(hdr(qcUser)).send({
      projectId, protocolId, customerWitness: 'Mr. Client',
    });
    expect(res.status).toBe(201);
    expect(res.body.fatNo).toMatch(/^FAT\//);
    expect(res.body.status).toBe('SCHEDULED');
    createdId = res.body.fatId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without FAT.CREATE (sales -> 403, view-only)', async () => {
    const res = await request(app).post('/api/fat').set(hdr(salesUser)).send({ projectId, protocolId });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing required ids', async () => {
    const r1 = await request(app).post('/api/fat').set(hdr(qcUser)).send({ protocolId });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/fat').set(hdr(qcUser)).send({ projectId, protocolId, fatDate: 'not-a-date' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/fat');
    expect(res.status).toBe(401);
  });

  it('lists FATs (200) and allows the SALES view-only role to read', async () => {
    const res = await request(app).get('/api/fat?status=SCHEDULED').set(hdr(qcUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asSales = await request(app).get('/api/fat').set(hdr(salesUser));
    expect(asSales.status).toBe(200);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/fat/${createdId}`).set(hdr(qcUser));
    expect(ok.status).toBe(200);
    expect(ok.body.projectId).toBe(projectId);
    const no = await request(app).get('/api/fat/99999999').set(hdr(qcUser));
    expect(no.status).toBe(404);
  });

  it('records a PASS result, then signs off (approve) to the Dispatch-clearance state', async () => {
    const paramId = Number((await pool.query(
      `SELECT param_id FROM qms.fat_protocol_param WHERE protocol_id=$1 AND seq=1`, [protocolId])).rows[0].param_id);
    const result = await request(app).post(`/api/fat/${createdId}/result`).set(hdr(qcUser)).send({
      result: 'PASS', rowVersion: createdVersion,
      lines: [{ paramId, measuredValue: 45, passFail: 'PASS' }],
    });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('PASSED');
    expect(result.body.result).toBe('PASS');

    // sign-off is guarded by FAT.APPROVE — qc_user holds it.
    const ok = await request(app).post(`/api/fat/${createdId}/approve`).set(hdr(qcUser)).send({
      rowVersion: result.body.rowVersion, customerWitness: 'Mr. Client',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('CLEARED');
    expect(ok.body.signoffBy).toBe(qcUser);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/fat').set(hdr(qcUser)).send({ projectId, protocolId });
    expect(create.status).toBe(201);
    const id = create.body.fatId;
    // move it forward once so the original version is now stale
    await request(app).post(`/api/fat/${id}/status`).set(hdr(qcUser))
      .send({ status: 'IN_PROGRESS', rowVersion: create.body.rowVersion });
    const stale = await request(app).post(`/api/fat/${id}/status`).set(hdr(qcUser))
      .send({ status: 'CANCELLED', rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
