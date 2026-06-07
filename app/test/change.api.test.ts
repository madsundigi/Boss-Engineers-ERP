import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { changeRouter } from '../src/modules/change/change.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts changeRouter at /api/change-orders exactly as the composition
 * root does (createApp wires `app.use('/api/change-orders', changeRouter(pool))`);
 * here we mount a minimal equivalent so the module is testable independently of
 * app.ts.
 *
 * Change / Variation Management: PLANNING / SALES raise a variation
 * (CHANGE_ORDER.CREATE); PLANNING amends + submits (CHANGE_ORDER.EDIT); CEO /
 * FINANCE approve or reject (CHANGE_ORDER.APPROVE). APPROVE enforces SoD
 * (approver != creator) and emits 'change_order.approved' for downstream
 * re-cost / re-baseline (Profitability / Planning).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/change-orders', changeRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Change Order API (integration) — create, approval lifecycle, SoD, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let planningUser: number;
  let salesUser: number;
  let ceoUser: number;
  let financeUser: number;
  let productionUser: number;
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
    planningUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='planning_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    ceoUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='ceo_user'`)).user_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);

    // Master data the change order references (project_id is a NOT NULL FK on
    // proj.change_order and is not in the base seed). The test connects as the
    // owning superuser, so RLS does not filter these inserts. A pm_user_id is required.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-CO-TEST', 'Change Order Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, planningUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates a change order (201) with an auto-generated CO number, in DRAFT', async () => {
    const res = await request(app).post('/api/change-orders').set(hdr(planningUser)).send({
      projectId,
      description: 'Add stainless cladding to skid frame',
      reason: 'Customer site is coastal/corrosive',
      costImpact: 50000,
      priceImpact: 65000,
      scheduleImpactDays: 7,
    });
    expect(res.status).toBe(201);
    expect(res.body.changeNo).toMatch(/^CO\//);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.projectId).toBe(projectId);
    expect(Number(res.body.costImpact)).toBe(50000);
    createdId = res.body.changeOrderId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without CHANGE_ORDER.CREATE (production -> 403, view-only)', async () => {
    const res = await request(app).post('/api/change-orders').set(hdr(productionUser))
      .send({ projectId, description: 'unauthorized' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing required fields', async () => {
    const r1 = await request(app).post('/api/change-orders').set(hdr(planningUser)).send({ projectId });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/change-orders').set(hdr(planningUser))
      .send({ description: 'no project id' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/change-orders');
    expect(res.status).toBe(401);
  });

  it('lists change orders (200) and allows the PRODUCTION view-only role to read', async () => {
    const res = await request(app).get('/api/change-orders?status=DRAFT').set(hdr(planningUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asProd = await request(app).get('/api/change-orders').set(hdr(productionUser));
    expect(asProd.status).toBe(200);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/change-orders/${createdId}`).set(hdr(planningUser));
    expect(ok.status).toBe(200);
    expect(ok.body.projectId).toBe(projectId);
    const no = await request(app).get('/api/change-orders/99999999').set(hdr(planningUser));
    expect(no.status).toBe(404);
  });

  it('submits the change order for approval (DRAFT -> SUBMITTED) as PLANNING', async () => {
    const res = await request(app).post(`/api/change-orders/${createdId}/submit`).set(hdr(planningUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUBMITTED');
    createdVersion = res.body.rowVersion;
  });

  it('blocks the creator from approving their own change order (planning lacks APPROVE -> 403)', async () => {
    // PLANNING (the creator) is not granted CHANGE_ORDER.APPROVE — the RBAC guard
    // denies before the per-row SoD check; either way a self-approval is blocked.
    const res = await request(app).post(`/api/change-orders/${createdId}/approve`).set(hdr(planningUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(403);
  });

  it('approves as a second authorized approver (CEO) and emits change_order.approved', async () => {
    const res = await request(app).post(`/api/change-orders/${createdId}/approve`).set(hdr(ceoUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    createdVersion = res.body.rowVersion;

    // the approval recorded a transactional-outbox event for downstream consumers
    // (M15 Profitability / Planning re-cost + re-baseline).
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='CHANGE_ORDER' AND aggregate_id=$1 AND event_type='change_order.approved'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.changeNo).toMatch(/^CO\//);
    expect(evt.rows[0].payload.projectId).toBe(projectId);
    expect(Number(evt.rows[0].payload.costImpact)).toBe(50000);
  });

  it('marks an APPROVED change order as IMPLEMENTED (re-baseline applied) as PLANNING', async () => {
    const res = await request(app).post(`/api/change-orders/${createdId}/implement`).set(hdr(planningUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IMPLEMENTED');
  });

  it('rejects a SUBMITTED change order with a reason as FINANCE', async () => {
    const create = await request(app).post('/api/change-orders').set(hdr(planningUser))
      .send({ projectId, description: 'De-scope painting', costImpact: -12000, priceImpact: -15000 });
    expect(create.status).toBe(201);
    const id = create.body.changeOrderId;
    const submit = await request(app).post(`/api/change-orders/${id}/submit`).set(hdr(planningUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(submit.status).toBe(200);
    const reject = await request(app).post(`/api/change-orders/${id}/reject`).set(hdr(financeUser))
      .send({ reason: 'Scope is contractual; not a variation', rowVersion: submit.body.rowVersion });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe('REJECTED');
    expect(reject.body.reason).toMatch(/contractual/);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/change-orders').set(hdr(planningUser))
      .send({ projectId, description: 'Concurrency probe', costImpact: 1000, priceImpact: 1200 });
    expect(create.status).toBe(201);
    const id = create.body.changeOrderId;
    // submit once so the original version is now stale
    const submit = await request(app).post(`/api/change-orders/${id}/submit`).set(hdr(planningUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(submit.status).toBe(200);
    // approving with the now-stale create version must 409
    const stale = await request(app).post(`/api/change-orders/${id}/approve`).set(hdr(ceoUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
