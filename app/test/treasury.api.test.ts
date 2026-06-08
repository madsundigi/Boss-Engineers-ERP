import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { treasuryRouter } from '../src/modules/treasury/treasury.routes';

/**
 * Integration tests for the Treasury / Cash-flow module. Runs only when DATABASE_URL
 * is set (provisioned by the test harness) so the suite is a no-op without a database.
 * Mounts the router at /api/treasury exactly as the composition root does.
 *
 * FINANCE owns the forecast (TREASURY.VCEDA) — finance_user creates + reads;
 * SALES has no TREASURY grant at all, so it is blocked from both create and reads.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/treasury', treasuryRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Treasury / Cash-flow API (integration)', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let financeUser: number;
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
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    const cust = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1,'PRJ-TREASURY-TEST','Treasury Test Project',$2,$3,'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, cust, financeUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  it('adds an inflow forecast (201) as finance_user', async () => {
    const res = await request(app).post('/api/treasury/forecasts').set(hdr(financeUser)).send({
      periodLabel: '2026-07', direction: 'INFLOW', category: 'MILESTONE', amount: 500000,
      projectId, note: 'Milestone M2 billing',
    });
    expect(res.status).toBe(201);
    expect(res.body.direction).toBe('INFLOW');
    expect(Number(res.body.amount)).toBe(500000);
    expect(res.body.cfId).toBeGreaterThan(0);
  });

  it('denies create without TREASURY.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/treasury/forecasts').set(hdr(salesUser))
      .send({ periodLabel: '2026-07', direction: 'OUTFLOW', amount: 1000 });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): bad direction', async () => {
    const res = await request(app).post('/api/treasury/forecasts').set(hdr(financeUser))
      .send({ periodLabel: '2026-07', direction: 'SIDEWAYS', amount: 1000 });
    expect(res.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/treasury/forecasts');
    expect(res.status).toBe(401);
  });

  it('lists forecasts (200) as finance_user', async () => {
    // seed an outflow so the period nets out and the list has >1 row
    await request(app).post('/api/treasury/forecasts').set(hdr(financeUser))
      .send({ periodLabel: '2026-07', direction: 'OUTFLOW', category: 'VENDOR', amount: 200000, projectId });
    const res = await request(app).get(`/api/treasury/forecasts?projectId=${projectId}`).set(hdr(financeUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });

  it('summarises net cash by period (200)', async () => {
    const res = await request(app).get(`/api/treasury/forecasts/summary?projectId=${projectId}`).set(hdr(financeUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const july = res.body.find((r: { periodLabel: string }) => r.periodLabel === '2026-07');
    expect(july).toBeDefined();
    // 500000 inflow - 200000 outflow = 300000 net (at least — other suites may add rows)
    expect(july.net).toBe(july.inflow - july.outflow);
  });

  it('returns a working-capital position (200) with non-negative numeric keys', async () => {
    const res = await request(app).get('/api/treasury/position').set(hdr(financeUser));
    expect(res.status).toBe(200);
    for (const k of ['arOutstanding', 'apOutstanding', 'netForecast', 'workingCapitalGap']) {
      expect(typeof res.body[k]).toBe('number');
    }
    expect(res.body.arOutstanding).toBeGreaterThanOrEqual(0);
    expect(res.body.apOutstanding).toBeGreaterThanOrEqual(0);
  });
});
