import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { crmRouter } from '../src/modules/crm/crm.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts crmRouter at /api/crm exactly as the composition root does
 * (createApp wires `app.use('/api/crm', crmRouter(pool))`); here we mount a minimal
 * equivalent so the module is testable independently of app.ts.
 *
 * CRM — sales opportunity pipeline + follow-up activities + customer-360. The CRM
 * domain grants SALES the pipeline (CRM.VCEDA) and FINANCE read-only (CRM.V), so a
 * create as finance_user is denied 403. WIN emits 'opportunity.won'.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/crm', crmRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('CRM API (integration) — opportunity pipeline, activities, customer-360, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let salesUser: number;
  let financeUser: number;
  let ceoUser: number;
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
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    ceoUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='ceo_user'`)).user_id);

    // Master data the opportunity references (customer). The test connects as the
    // owning superuser, so RLS does not filter this read.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates an opportunity (201) with an auto-generated OPP number, in NEW', async () => {
    const res = await request(app).post('/api/crm/opportunities').set(hdr(salesUser)).send({
      customerId,
      title: 'Pumping skid for Plant 2',
      estValue: 250000,
      probabilityPct: 20,
      expectedCloseDate: '2026-09-30',
    });
    expect(res.status).toBe(201);
    expect(res.body.oppNo).toMatch(/^OPP\//);
    expect(res.body.stage).toBe('NEW');
    expect(Number(res.body.estValue)).toBe(250000);
    createdId = res.body.oppId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without CRM.CREATE (finance -> 403, view-only)', async () => {
    const res = await request(app).post('/api/crm/opportunities').set(hdr(financeUser))
      .send({ customerId, title: 'X' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing title / bad date', async () => {
    const r1 = await request(app).post('/api/crm/opportunities').set(hdr(salesUser)).send({ customerId });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/crm/opportunities').set(hdr(salesUser))
      .send({ customerId, title: 'X', expectedCloseDate: 'not-a-date' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/crm/opportunities');
    expect(res.status).toBe(401);
  });

  it('lists opportunities (200) and allows the FINANCE view-only role to read', async () => {
    const res = await request(app).get('/api/crm/opportunities?stage=NEW').set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asFin = await request(app).get('/api/crm/opportunities').set(hdr(financeUser));
    expect(asFin.status).toBe(200);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/crm/opportunities/${createdId}`).set(hdr(salesUser));
    expect(ok.status).toBe(200);
    expect(ok.body.customerId).toBe(customerId);
    const no = await request(app).get('/api/crm/opportunities/99999999').set(hdr(salesUser));
    expect(no.status).toBe(404);
  });

  it('advances NEW -> QUALIFIED, then wins (emits opportunity.won)', async () => {
    const adv = await request(app).post(`/api/crm/opportunities/${createdId}/advance`).set(hdr(salesUser))
      .send({ stage: 'QUALIFIED', rowVersion: createdVersion });
    expect(adv.status).toBe(200);
    expect(adv.body.stage).toBe('QUALIFIED');
    createdVersion = adv.body.rowVersion;

    const win = await request(app).post(`/api/crm/opportunities/${createdId}/win`).set(hdr(salesUser))
      .send({ rowVersion: createdVersion });
    expect(win.status).toBe(200);
    expect(win.body.stage).toBe('WON');
    createdVersion = win.body.rowVersion;

    // the win recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='OPPORTUNITY' AND aggregate_id=$1 AND event_type='opportunity.won'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.oppNo).toMatch(/^OPP\//);
    expect(evt.rows[0].payload.customerId).toBe(customerId);
    expect(Number(evt.rows[0].payload.estValue)).toBe(250000);
  });

  it('returns a pipeline summary (200) grouped by stage', async () => {
    const res = await request(app).get('/api/crm/opportunities/pipeline').set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const won = res.body.find((s: { stage: string }) => s.stage === 'WON');
    expect(won).toBeDefined();
    expect(won.count).toBeGreaterThanOrEqual(1);
  });

  it('returns a weighted revenue forecast (200): weightedTotal + byStage math, WON/LOST excluded', async () => {
    // Seed a deterministic set of opportunities in a unique, far-future close month so a
    // ?fromDate/&toDate window isolates exactly these rows from any other test/seed data.
    // The owning superuser connection bypasses RLS, so set company_id explicitly.
    const FROM = '2099-12-01';
    const TO = '2099-12-31';
    const seed = async (
      no: string, stage: string, est: number, prob: number, close: string | null,
    ) => pool.query(
      `INSERT INTO crm.opportunity
         (company_id, bu_id, opp_no, customer_id, title, stage, est_value, probability_pct,
          expected_close_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10)`,
      [companyId, buId, no, customerId, 'Forecast-test ' + no, stage, est, prob, close, salesUser]);

    // Open pipeline (counts toward weighted + gross): 100k@20% + 200k@50% + 400k@80%
    //   -> gross = 700000, weighted = 20000 + 100000 + 320000 = 440000
    await seed('OPP-FC-NEW',  'NEW',         100000, 20, '2099-12-10');
    await seed('OPP-FC-PROP', 'PROPOSAL',    200000, 50, '2099-12-15');
    await seed('OPP-FC-NEG',  'NEGOTIATION', 400000, 80, '2099-12-20');
    // Terminal rows in the SAME window — must be EXCLUDED from the weighted/gross open totals.
    await seed('OPP-FC-WON',  'WON',         999000, 90, '2099-12-25');
    await seed('OPP-FC-LOST', 'LOST',        888000, 70, '2099-12-28');

    const res = await request(app)
      .get(`/api/crm/opportunities/forecast?fromDate=${FROM}&toDate=${TO}`).set(hdr(salesUser));
    expect(res.status).toBe(200);

    // Open-pipeline totals are exact within the isolated window.
    expect(Number(res.body.grossOpenTotal)).toBe(700000);
    expect(Number(res.body.weightedTotal)).toBe(440000);
    // WON is reported separately (and only WON within the window here = 999000).
    expect(Number(res.body.wonTotal)).toBe(999000);

    // byStage covers only the OPEN stages; WON / LOST never appear.
    const stages = res.body.byStage as Array<{ stage: string; count: number; gross: number; weighted: number }>;
    expect(stages.some((s) => s.stage === 'WON' || s.stage === 'LOST')).toBe(false);
    const neg = stages.find((s) => s.stage === 'NEGOTIATION');
    expect(neg).toBeDefined();
    expect(Number(neg!.gross)).toBe(400000);
    expect(Number(neg!.weighted)).toBe(320000); // 400000 * 80/100

    // byMonth buckets the three open rows under the seeded close month.
    const dec = (res.body.byMonth as Array<{ month: string; gross: number; weighted: number }>)
      .find((m) => m.month === '2099-12');
    expect(dec).toBeDefined();
    expect(Number(dec!.gross)).toBe(700000);
    expect(Number(dec!.weighted)).toBe(440000);

    // FINANCE is view-only (CRM.V) and may read the forecast.
    const asFin = await request(app).get('/api/crm/opportunities/forecast').set(hdr(financeUser));
    expect(asFin.status).toBe(200);

    // Clean up the seeded rows so re-runs stay deterministic.
    await pool.query(`DELETE FROM crm.opportunity WHERE opp_no LIKE 'OPP-FC-%' AND company_id=$1`, [companyId]);
  });

  it('buckets open opportunities with no close date under "unscheduled"', async () => {
    await pool.query(
      `INSERT INTO crm.opportunity
         (company_id, bu_id, opp_no, customer_id, title, stage, est_value, probability_pct,
          expected_close_date, created_by)
       VALUES ($1,$2,'OPP-FC-NULL',$3,'Forecast unscheduled','QUALIFIED',50000,40,NULL,$4)`,
      [companyId, buId, customerId, salesUser]);

    const res = await request(app).get('/api/crm/opportunities/forecast').set(hdr(salesUser));
    expect(res.status).toBe(200);
    const un = (res.body.byMonth as Array<{ month: string; weighted: number }>)
      .find((m) => m.month === 'unscheduled');
    expect(un).toBeDefined();
    expect(Number(un!.weighted)).toBeGreaterThanOrEqual(20000); // includes 50000 * 40/100

    await pool.query(`DELETE FROM crm.opportunity WHERE opp_no='OPP-FC-NULL' AND company_id=$1`, [companyId]);
  });

  it('rejects an invalid forecast window (400) when toDate precedes fromDate', async () => {
    const res = await request(app)
      .get('/api/crm/opportunities/forecast?fromDate=2099-12-31&toDate=2099-01-01').set(hdr(salesUser));
    expect(res.status).toBe(400);
  });

  it('creates an activity (201) then completes it (-> DONE)', async () => {
    const create = await request(app).post('/api/crm/activities').set(hdr(salesUser)).send({
      oppId: createdId, customerId,
      activityType: 'CALL', subject: 'Kickoff call', dueDate: '2026-07-01',
    });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('PENDING');
    const activityId = create.body.activityId;

    const list = await request(app).get(`/api/crm/activities?oppId=${createdId}`).set(hdr(salesUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const done = await request(app).post(`/api/crm/activities/${activityId}/complete`).set(hdr(salesUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('DONE');
    expect(done.body.completedAt).not.toBeNull();
  });

  it('reads a customer-360 (200) aggregating the customer pipeline + activities', async () => {
    const res = await request(app).get(`/api/crm/customers/${customerId}/360`).set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(res.body.customerId).toBe(customerId);
    expect(Array.isArray(res.body.pipeline)).toBe(true);
    expect(Array.isArray(res.body.openActivities)).toBe(true);
    expect(res.body.wonOpportunityCount).toBeGreaterThanOrEqual(1);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    // create a fresh opportunity, advance once so the original version is now stale.
    const create = await request(app).post('/api/crm/opportunities').set(hdr(salesUser))
      .send({ customerId, title: 'Stale-test opp', estValue: 1000 });
    expect(create.status).toBe(201);
    const id = create.body.oppId;
    const first = await request(app).post(`/api/crm/opportunities/${id}/advance`).set(hdr(salesUser))
      .send({ stage: 'QUALIFIED', rowVersion: create.body.rowVersion });
    expect(first.status).toBe(200);
    const stale = await request(app).post(`/api/crm/opportunities/${id}/advance`).set(hdr(salesUser))
      .send({ stage: 'PROPOSAL', rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
