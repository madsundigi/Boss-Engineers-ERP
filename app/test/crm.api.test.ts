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
