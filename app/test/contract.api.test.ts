import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { contractRouter } from '../src/modules/contract/contract.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts contractRouter at /api/contracts exactly as the composition root
 * does (createApp wires `app.use('/api/contracts', contractRouter(pool))`); here we
 * mount a minimal equivalent so the module is testable independently of app.ts.
 *
 * This is the COMMERCIAL customer contract (sales.customer_contract): SALES owns
 * the document (CONTRACT.VCE — create/edit, no approve); FINANCE activates it
 * (CONTRACT.APPROVE) — being a different user, the per-row Segregation-of-Duties
 * check also passes. ACTIVATE emits 'contract.activated'.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/contracts', contractRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Contract API (integration) — create, activation lifecycle, milestones, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let salesUser: number;
  let financeUser: number;
  let ceoUser: number;
  let productionUser: number;
  let customerId: number;
  let currencyId: number;
  let projectId: number;

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
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);

    // Master data the contract references (customer + currency + an optional
    // project). The test connects as the owning superuser, so RLS does not filter
    // these inserts. A pm_user_id is required on proj.project.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    currencyId = Number((await one(`SELECT currency_id FROM mdm.currency WHERE iso_code='INR'`)).currency_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-CON-TEST', 'Contract Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, salesUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;
  let milestoneId: number;

  it('creates a contract (201) with an auto-generated CON number, in DRAFT, with a milestone', async () => {
    const res = await request(app).post('/api/contracts').set(hdr(salesUser)).send({
      customerId, projectId, currencyId,
      title: 'Supply, Install & Commission',
      contractValue: 100000,
      paymentTerms: '30% advance, 60% on delivery, 10% on FAT',
      ldPenaltyPct: 0.5, ldCapPct: 10, warrantyMonths: 18,
      startDate: '2026-06-01', endDate: '2027-12-01', signedDate: '2026-05-25',
      milestones: [{ name: 'Advance', milestonePct: 30, dueDate: '2026-07-01' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.contractNo).toMatch(/^CON\//);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.milestones).toHaveLength(1);
    // amount derived from pct (30% of 100000) since none supplied explicitly.
    expect(Number(res.body.milestones[0].amount)).toBe(30000);
    expect(res.body.milestones[0].status).toBe('PENDING');
    createdId = res.body.contractId;
    createdVersion = res.body.rowVersion;
    milestoneId = res.body.milestones[0].milestoneId;
  });

  it('denies create without CONTRACT.CREATE (production -> 403, view-only)', async () => {
    const res = await request(app).post('/api/contracts').set(hdr(productionUser))
      .send({ customerId, contractValue: 1 });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing customer + bad date', async () => {
    const r1 = await request(app).post('/api/contracts').set(hdr(salesUser)).send({ contractValue: 1 });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/contracts').set(hdr(salesUser))
      .send({ customerId, startDate: 'not-a-date' });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/contracts');
    expect(res.status).toBe(401);
  });

  it('lists contracts (200) and allows the PRODUCTION view-only role to read', async () => {
    const res = await request(app).get('/api/contracts?status=DRAFT').set(hdr(salesUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asProd = await request(app).get('/api/contracts').set(hdr(productionUser));
    expect(asProd.status).toBe(200);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/contracts/${createdId}`).set(hdr(salesUser));
    expect(ok.status).toBe(200);
    expect(ok.body.customerId).toBe(customerId);
    expect(ok.body.milestones).toHaveLength(1);
    const no = await request(app).get('/api/contracts/99999999').set(hdr(salesUser));
    expect(no.status).toBe(404);
  });

  it('denies activation to a role without CONTRACT.APPROVE (sales -> 403)', async () => {
    const res = await request(app).post(`/api/contracts/${createdId}/activate`).set(hdr(salesUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(403);
  });

  it('activates as FINANCE (200, ACTIVE) and emits contract.activated', async () => {
    const res = await request(app).post(`/api/contracts/${createdId}/activate`).set(hdr(financeUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    createdVersion = res.body.rowVersion;

    // the activation recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='CONTRACT' AND aggregate_id=$1 AND event_type='contract.activated'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.contractNo).toMatch(/^CON\//);
    expect(evt.rows[0].payload.customerId).toBe(customerId);
    expect(Number(evt.rows[0].payload.contractValue)).toBe(100000);
  });

  it('marks a billing milestone INVOICED then PAID (CONTRACT.EDIT)', async () => {
    const inv = await request(app)
      .post(`/api/contracts/${createdId}/milestones/${milestoneId}/invoice`).set(hdr(salesUser)).send({});
    expect(inv.status).toBe(200);
    expect(inv.body.milestones.find((m: { milestoneId: number }) => m.milestoneId === milestoneId).status)
      .toBe('INVOICED');

    const paid = await request(app)
      .post(`/api/contracts/${createdId}/milestones/${milestoneId}/pay`).set(hdr(financeUser)).send({});
    expect(paid.status).toBe(200);
    expect(paid.body.milestones.find((m: { milestoneId: number }) => m.milestoneId === milestoneId).status)
      .toBe('PAID');
    createdVersion = paid.body.rowVersion;
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    // create a fresh DRAFT contract, then activate twice with the same (now stale) version.
    const create = await request(app).post('/api/contracts').set(hdr(salesUser))
      .send({ customerId, currencyId, contractValue: 5000 });
    expect(create.status).toBe(201);
    const id = create.body.contractId;
    const first = await request(app).post(`/api/contracts/${id}/activate`).set(hdr(financeUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(first.status).toBe(200);
    const stale = await request(app).post(`/api/contracts/${id}/close`).set(hdr(financeUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
