import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { deliveryRouter } from '../src/modules/delivery/delivery.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts deliveryRouter at /api/delivery-forecasts exactly as the
 * composition root does; here we mount a minimal equivalent so the module is
 * testable independently of app.ts.
 *
 * Delivery Prediction is APPEND-ONLY: PLANNING creates forecast snapshots
 * (DELIVERY_FORECAST.CREATE); ADMIN/CEO/FINANCE/PLANNING/PRODUCTION/SALES read
 * (VIEW); there is NO update and NO delete route. A HIGH-risk forecast emits the
 * transactional-outbox event 'delivery.at_risk'.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/delivery-forecasts', deliveryRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Delivery Prediction API (integration) — append-only forecast log, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let planningUser: number;
  let salesUser: number;
  let productionUser: number;
  let projectId: number;
  let customerId: number;
  let vendorId: number;
  let currencyId: number;
  let itemId: number;

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
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);

    // Master data the forecast references (project_id is a NOT NULL FK on
    // proj.delivery_forecast and is not in the base seed). The test connects as the
    // owning superuser, so RLS does not filter these inserts. A pm_user_id is required.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    // Upstream-signal seeds reference a vendor (PO), a currency (PO) and an item (WO).
    vendorId = Number((await one(
      `SELECT vendor_id FROM mdm.vendor WHERE vendor_code='VEND-TEST' AND company_id=$1`, [companyId])).vendor_id);
    currencyId = Number((await one(`SELECT currency_id FROM mdm.currency WHERE iso_code='INR'`)).currency_id);
    itemId = Number((await one(
      `SELECT item_id FROM mdm.item WHERE item_code='ITEM-TEST' AND company_id=$1`, [companyId])).item_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-DLV-TEST', 'Delivery Forecast Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, planningUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;

  it('creates a forecast (201) as PLANNING; delay_days is computed from the dates', async () => {
    const res = await request(app).post('/api/delivery-forecasts').set(hdr(planningUser)).send({
      projectId,
      predictedDelivery: '2026-09-15',
      committedDelivery: '2026-09-01', // predicted is 14 days later -> positive delay
      riskLevel: 'MEDIUM',
      driver: 'SCHEDULE',
    });
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.delayDays).toBe(14); // generated column (predicted - committed)
    expect(res.body.createdBy).toBe(planningUser);
    createdId = res.body.forecastId;
  });

  it('denies create without DELIVERY_FORECAST.CREATE (sales -> 403, view-only)', async () => {
    const res = await request(app).post('/api/delivery-forecasts').set(hdr(salesUser))
      .send({ projectId, predictedDelivery: '2026-09-20' });
    expect(res.status).toBe(403);
  });

  it('rejects invalid bodies (400): missing predicted_delivery, bad risk, bad driver', async () => {
    const noPredicted = await request(app).post('/api/delivery-forecasts').set(hdr(planningUser)).send({ projectId });
    expect(noPredicted.status).toBe(400);
    const badRisk = await request(app).post('/api/delivery-forecasts').set(hdr(planningUser))
      .send({ projectId, predictedDelivery: '2026-09-15', riskLevel: 'CRITICAL' });
    expect(badRisk.status).toBe(400);
    const badDriver = await request(app).post('/api/delivery-forecasts').set(hdr(planningUser))
      .send({ projectId, predictedDelivery: '2026-09-15', driver: 'WEATHER' });
    expect(badDriver.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/delivery-forecasts');
    expect(res.status).toBe(401);
  });

  it('lists forecasts (200, >=1) and allows the SALES view-only role to read', async () => {
    const res = await request(app).get(`/api/delivery-forecasts?projectId=${projectId}`).set(hdr(planningUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asSales = await request(app).get('/api/delivery-forecasts').set(hdr(salesUser));
    expect(asSales.status).toBe(200);
    const asProduction = await request(app).get('/api/delivery-forecasts').set(hdr(productionUser));
    expect(asProduction.status).toBe(200);
  });

  it('returns the latest forecast for a project (200); 404 for a project with none', async () => {
    // A newer snapshot (revision): the latest must win over the first row.
    const newer = await request(app).post('/api/delivery-forecasts').set(hdr(planningUser)).send({
      projectId, predictedDelivery: '2026-10-01', committedDelivery: '2026-09-01', riskLevel: 'LOW',
    });
    expect(newer.status).toBe(201);

    const latest = await request(app).get(`/api/delivery-forecasts/latest/${projectId}`).set(hdr(planningUser));
    expect(latest.status).toBe(200);
    expect(latest.body.forecastId).toBe(newer.body.forecastId);

    const none = await request(app).get('/api/delivery-forecasts/latest/99999999').set(hdr(planningUser));
    expect(none.status).toBe(404);
  });

  it('emits a delivery.at_risk outbox event for a HIGH-risk forecast', async () => {
    const res = await request(app).post('/api/delivery-forecasts').set(hdr(planningUser)).send({
      projectId, predictedDelivery: '2026-12-01', committedDelivery: '2026-09-01',
      riskLevel: 'HIGH', driver: 'MATERIAL',
    });
    expect(res.status).toBe(201);

    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='DELIVERY_FORECAST' AND aggregate_id=$1 AND event_type='delivery.at_risk'`,
      [projectId]);
    expect(evt.rowCount).toBeGreaterThanOrEqual(1);
    expect(evt.rows[0].payload.projectId).toBe(projectId);
    expect(evt.rows[0].payload.driver).toBe('MATERIAL');
  });

  it('derives AUTO delivery-risk from upstream signals (GET /risk/:projectId)', async () => {
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
    const stamp = Date.now();

    // A fresh project so the three signal counts are exact (isolated from the
    // forecast-test project's rows). Owner connection bypasses RLS for the seed.
    const riskProject = Number((await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, $2, 'Delivery Risk Test Project', $3, $4, 'ACTIVE')
       RETURNING project_id`,
      [companyId, `PRJ-DLV-RISK-${stamp}`, customerId, planningUser])).project_id);

    // GREEN first: a brand-new project with no upstream rows has no risk.
    const green = await request(app).get(`/api/delivery-forecasts/risk/${riskProject}`).set(hdr(planningUser));
    expect(green.status).toBe(200);
    expect(green.body).toMatchObject({
      projectId: riskProject, riskLevel: 'GREEN', driver: null,
      signals: { overduePurchaseOrders: 0, delayedWorkOrders: 0, pendingOrFailedFats: 0 },
    });

    // One overdue PO (APPROVED, expected_date in the past) -> Purchase Delay.
    await one(
      `INSERT INTO scm.purchase_order
         (company_id, po_no, vendor_id, project_id, currency_id, total_amount, expected_date, status)
       VALUES ($1, $2, $3, $4, $5, 1000, CURRENT_DATE - 7, 'APPROVED')`,
      [companyId, `PO-DLV-${stamp}`, vendorId, riskProject, currencyId]);
    // One delayed WO (IN_PROGRESS, planned_end in the past) -> Production Delay.
    await one(
      `INSERT INTO mfg.work_order
         (company_id, wo_no, project_id, item_id, qty, planned_end, status)
       VALUES ($1, $2, $3, $4, 1, CURRENT_DATE - 3, 'IN_PROGRESS')`,
      [companyId, `WO-DLV-${stamp}`, riskProject, itemId]);
    // One pending/failed FAT (FAILED) -> Resource/FAT Delay (forces RED + QUALITY).
    const protoId = Number((await one(
      `INSERT INTO qms.fat_protocol (company_id, protocol_code, protocol_name)
       VALUES ($1, $2, 'DLV Risk Protocol') RETURNING protocol_id`,
      [companyId, `FATP/DLV/${stamp}`])).protocol_id);
    await one(
      `INSERT INTO qms.fat_execution (company_id, fat_no, project_id, protocol_id, status)
       VALUES ($1, $2, $3, $4, 'FAILED')`,
      [companyId, `FAT/DLV/${stamp}`, riskProject, protoId]);

    const red = await request(app).get(`/api/delivery-forecasts/risk/${riskProject}`).set(hdr(planningUser));
    expect(red.status).toBe(200);
    expect(red.body.signals).toEqual({
      overduePurchaseOrders: 1, delayedWorkOrders: 1, pendingOrFailedFats: 1,
    });
    expect(red.body.riskLevel).toBe('RED');       // a pending/failed FAT alone forces RED
    expect(red.body.driver).toBe('QUALITY');      // FAT is the largest signal
    expect(typeof red.body.asOf).toBe('string');

    // SALES holds DELIVERY_FORECAST.VIEW, so the read is permitted (200, not 403).
    const asSales = await request(app).get(`/api/delivery-forecasts/risk/${riskProject}`).set(hdr(salesUser));
    expect(asSales.status).toBe(200);

    // 404 for a project that does not exist for this company.
    const missing = await request(app).get('/api/delivery-forecasts/risk/99999999').set(hdr(planningUser));
    expect(missing.status).toBe(404);

    // 400 for a non-positive / non-integer projectId (param validation).
    const bad = await request(app).get('/api/delivery-forecasts/risk/0').set(hdr(planningUser));
    expect(bad.status).toBe(400);
  });

  it('exposes NO update/delete route (append-only): PUT/PATCH/DELETE -> 404', async () => {
    const put = await request(app).put(`/api/delivery-forecasts/${createdId}`).set(hdr(planningUser)).send({});
    expect(put.status).toBe(404);
    const patch = await request(app).patch(`/api/delivery-forecasts/${createdId}`).set(hdr(planningUser)).send({});
    expect(patch.status).toBe(404);
    const del = await request(app).delete(`/api/delivery-forecasts/${createdId}`).set(hdr(planningUser));
    expect(del.status).toBe(404);
  });
});
