import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { profitabilityRouter } from '../src/modules/profitability/profitability.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts profitabilityRouter at /api/profitability exactly as the
 * composition root does; here we mount a minimal equivalent so the module is
 * testable independently of app.ts.
 *
 * Profitability is APPEND-ONLY: FINANCE computes margin snapshots
 * (PROFITABILITY.CREATE); ADMIN/CEO/FINANCE/PLANNING read (VIEW); there is NO
 * update and NO delete route. Every computeSnapshot emits the transactional-outbox
 * event 'margin.snapshot.created'.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/profitability', profitabilityRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Profitability API (integration) — append-only margin snapshots, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let financeUser: number;
  let planningUser: number;
  let salesUser: number;
  let projectId: number;
  let customerId: number;

  // Seeded financials for the project (superuser inserts bypass RLS).
  const ACTUAL_COST = 300;
  const COMMITTED_COST = 500;
  const REVENUE = 1000;
  // margin_pct = (revenue - actual) / revenue * 100 = (1000 - 300) / 1000 * 100.
  const EXPECTED_MARGIN_PCT = 70;

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
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    planningUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='planning_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    // Master data the snapshot references (project_id is a NOT NULL FK on
    // fin.margin_snapshot and is not in the base seed). The test connects as the
    // owning superuser, so RLS does not filter these inserts. A pm_user_id is required.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-PRF-TEST', 'Profitability Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, financeUser]);
    projectId = Number(proj.project_id);

    // Seed cost-ledger rows (ACTUAL + COMMITTED) and an invoice so the computed
    // snapshot has non-trivial figures. Superuser bypasses RLS on these inserts.
    await pool.query(
      `INSERT INTO fin.project_cost_ledger
         (posting_date, company_id, project_id, cost_type, cost_stage, amount, ref_doc_type, ref_doc_id, created_by)
       VALUES (current_date, $1, $2, 'MATERIAL', 'ACTUAL',    $3, 'TEST', 1, $4),
              (current_date, $1, $2, 'MATERIAL', 'COMMITTED', $5, 'TEST', 1, $4)`,
      [companyId, projectId, ACTUAL_COST, financeUser, COMMITTED_COST]);

    await pool.query(
      `INSERT INTO fin.invoice
         (company_id, invoice_no, project_id, customer_id, currency_id, taxable_amount, total_amount, status, created_by)
       SELECT $1, 'INV-PRF-TEST', $2, $3, c.currency_id, $4, $4, 'POSTED', $5
         FROM mdm.currency c
        ORDER BY c.currency_id
        LIMIT 1
       ON CONFLICT (invoice_no) DO UPDATE SET taxable_amount = EXCLUDED.taxable_amount, status = EXCLUDED.status`,
      [companyId, projectId, customerId, REVENUE, financeUser]);
  });

  afterAll(async () => { await pool.end(); });

  it('computes a margin snapshot (201) as FINANCE; margin_pct derives from seeded revenue/cost', async () => {
    const res = await request(app).post('/api/profitability/compute').set(hdr(financeUser))
      .send({ projectId });
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe(projectId);
    expect(Number(res.body.revenue)).toBe(REVENUE);
    expect(Number(res.body.actualCost)).toBe(ACTUAL_COST);
    expect(Number(res.body.committedCost)).toBe(COMMITTED_COST);
    expect(Number(res.body.marginPct)).toBe(EXPECTED_MARGIN_PCT);
    // EAC = actual + max(committed - actual, 0) = 300 + 200 = 500.
    expect(Number(res.body.forecastCostEac)).toBe(500);

    // the compute recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='MARGIN_SNAPSHOT' AND aggregate_id=$1 AND event_type='margin.snapshot.created'`,
      [projectId]);
    expect(evt.rowCount).toBeGreaterThanOrEqual(1);
    expect(evt.rows[0].payload.projectId).toBe(projectId);
    expect(Number(evt.rows[0].payload.marginPct)).toBe(EXPECTED_MARGIN_PCT);
  });

  it('denies compute without PROFITABILITY.CREATE (planning is VIEW/APPROVE only -> 403)', async () => {
    const res = await request(app).post('/api/profitability/compute').set(hdr(planningUser))
      .send({ projectId });
    expect(res.status).toBe(403);
  });

  it('denies compute to a role without PROFITABILITY at all (sales -> 403)', async () => {
    const res = await request(app).post('/api/profitability/compute').set(hdr(salesUser))
      .send({ projectId });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing/blank projectId', async () => {
    const res = await request(app).post('/api/profitability/compute').set(hdr(financeUser)).send({});
    expect(res.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/profitability');
    expect(res.status).toBe(401);
  });

  it('lists snapshots (200, >=1) and allows the PLANNING view-only role to read', async () => {
    const res = await request(app).get(`/api/profitability?projectId=${projectId}`).set(hdr(financeUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asPlanning = await request(app).get('/api/profitability').set(hdr(planningUser));
    expect(asPlanning.status).toBe(200);
  });

  it('denies a read to a role without PROFITABILITY.VIEW (sales -> 403 even read)', async () => {
    const res = await request(app).get('/api/profitability').set(hdr(salesUser));
    expect(res.status).toBe(403);
  });

  it('returns the latest snapshot for a project (200); 404 for a project with none', async () => {
    const latest = await request(app).get(`/api/profitability/latest/${projectId}`).set(hdr(financeUser));
    expect(latest.status).toBe(200);
    expect(latest.body.projectId).toBe(projectId);
    expect(Number(latest.body.marginPct)).toBe(EXPECTED_MARGIN_PCT);

    const none = await request(app).get('/api/profitability/latest/99999999').set(hdr(financeUser));
    expect(none.status).toBe(404);
  });

  it('returns the project P&L (200) expanded from the latest snapshot', async () => {
    const res = await request(app).get(`/api/profitability/pnl/${projectId}`).set(hdr(planningUser));
    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(projectId);
    expect(Number(res.body.revenue)).toBe(REVENUE);
    expect(Number(res.body.actualCost)).toBe(ACTUAL_COST);
    // grossMargin = revenue - actualCost = 1000 - 300 = 700.
    expect(Number(res.body.grossMargin)).toBe(REVENUE - ACTUAL_COST);
  });

  it('returns the portfolio margin view (200): one row per project, latest snapshot', async () => {
    const res = await request(app).get('/api/profitability/portfolio').set(hdr(financeUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const mine = res.body.find((row: { projectId: number }) => row.projectId === projectId);
    expect(mine).toBeDefined();
    expect(Number(mine.marginPct)).toBe(EXPECTED_MARGIN_PCT);
  });

  it('exposes NO update/delete route (append-only): PUT/PATCH/DELETE -> 404', async () => {
    const put = await request(app).put(`/api/profitability/${projectId}`).set(hdr(financeUser)).send({});
    expect(put.status).toBe(404);
    const patch = await request(app).patch(`/api/profitability/${projectId}`).set(hdr(financeUser)).send({});
    expect(patch.status).toBe(404);
    const del = await request(app).delete(`/api/profitability/${projectId}`).set(hdr(financeUser));
    expect(del.status).toBe(404);
  });
});
