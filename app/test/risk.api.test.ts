import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { riskRouter } from '../src/modules/risk/risk.routes';

/**
 * Integration tests for the Project Risk Register. Runs only when DATABASE_URL is
 * set. Mounts the router exactly as the composition root does.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/risks', riskRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Risk Register API (integration)', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let planningUser: number;
  let ceoUser: number;
  let salesUser: number;
  let projectId: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId), 'x-company-id': String(companyId), 'x-bu-id': String(buId),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    planningUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='planning_user'`)).user_id);
    ceoUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='ceo_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    const cust = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1,'PRJ-RISK-TEST','Risk Test Project',$2,$3,'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, cust, planningUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let version: number;

  it('creates a risk (201) with a DB-computed severity', async () => {
    const res = await request(app).post('/api/risks').set(hdr(planningUser)).send({
      projectId, title: 'Long-lead motor slip', category: 'SUPPLY', likelihood: 4, impact: 5,
      mitigation: 'Dual-source + advance PO',
    });
    expect(res.status).toBe(201);
    expect(res.body.severity).toBe(20);
    expect(res.body.status).toBe('OPEN');
    createdId = res.body.riskId;
    version = res.body.rowVersion;
  });

  it('denies create without RISK.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/risks').set(hdr(salesUser))
      .send({ projectId, title: 'x', likelihood: 1, impact: 1 });
    expect(res.status).toBe(403);
  });

  it('rejects an out-of-range score (400)', async () => {
    const res = await request(app).post('/api/risks').set(hdr(planningUser))
      .send({ projectId, title: 'x', likelihood: 9, impact: 1 });
    expect(res.status).toBe(400);
  });

  it('requires authentication (401)', async () => {
    const res = await request(app).get('/api/risks');
    expect(res.status).toBe(401);
  });

  it('lists and fetches one (200), 404 unknown', async () => {
    const list = await request(app).get(`/api/risks?projectId=${projectId}`).set(hdr(planningUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    const ok = await request(app).get(`/api/risks/${createdId}`).set(hdr(planningUser));
    expect(ok.status).toBe(200);
    const no = await request(app).get('/api/risks/99999999').set(hdr(planningUser));
    expect(no.status).toBe(404);
  });

  it('mitigates then closes (CEO sign-off) and emits project_risk.closed', async () => {
    const mit = await request(app).post(`/api/risks/${createdId}/start-mitigation`).set(hdr(planningUser))
      .send({ rowVersion: version });
    expect(mit.status).toBe(200);
    expect(mit.body.status).toBe('MITIGATING');

    const close = await request(app).post(`/api/risks/${createdId}/close`).set(hdr(ceoUser))
      .send({ rowVersion: mit.body.rowVersion });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe('CLOSED');

    const evt = await pool.query(
      `SELECT 1 FROM mdm.outbox_event WHERE aggregate_type='PROJECT_RISK' AND aggregate_id=$1 AND event_type='project_risk.closed'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
  });

  it('409 on a stale row version', async () => {
    const create = await request(app).post('/api/risks').set(hdr(planningUser))
      .send({ projectId, title: 'Stale test', likelihood: 2, impact: 2 });
    const id = create.body.riskId;
    await request(app).post(`/api/risks/${id}/start-mitigation`).set(hdr(planningUser))
      .send({ rowVersion: create.body.rowVersion });
    const stale = await request(app).post(`/api/risks/${id}/close`).set(hdr(ceoUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
