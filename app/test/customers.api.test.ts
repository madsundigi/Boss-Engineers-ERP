import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { customersRouter } from '../src/modules/customers/customers.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts customersRouter at /api/customers exactly as the composition root
 * does (createApp wires `app.use('/api/customers', customersRouter(pool))`); here we
 * mount a minimal equivalent so the module is testable independently of app.ts.
 *
 * RBAC: SALES owns the master (CUSTOMER.VCEX — create/edit/view/export), ADMIN adds
 * delete (VCEDX); PRODUCTION has no CUSTOMER grant at all, so create is 403, and SALES
 * lacks DELETE so its delete is 403.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/customers', customersRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Customers API (integration) — master CRUD, RBAC, optimistic concurrency', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let currencyId: number;
  let salesUser: number;
  let adminUser: number;
  let productionUser: number;

  // Unique per run so re-running the suite never collides with the UNIQUE customer_code.
  const customerCode = `C-${Date.now()}`;

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
    currencyId = Number((await one(`SELECT currency_id FROM mdm.currency WHERE iso_code='INR'`)).currency_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    adminUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='admin_user'`)).user_id);
    productionUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='production_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates a customer (201) as sales_user, ACTIVE/OTHER by default', async () => {
    const res = await request(app).post('/api/customers').set(hdr(salesUser)).send({
      customerCode, customerName: 'Acme Steel Pvt Ltd', defaultCurrencyId: currencyId, creditLimit: 500000.5,
    });
    expect(res.status).toBe(201);
    expect(res.body.customerCode).toBe(customerCode);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.customerType).toBe('OTHER');
    expect(res.body.creditLimit).toBe(500000.5);
    createdId = res.body.customerId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without CUSTOMER.CREATE (production -> 403)', async () => {
    const res = await request(app).post('/api/customers').set(hdr(productionUser))
      .send({ customerCode: `${customerCode}-X`, customerName: 'Nope', defaultCurrencyId: currencyId });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing required default currency', async () => {
    const res = await request(app).post('/api/customers').set(hdr(salesUser))
      .send({ customerCode: `${customerCode}-Y`, customerName: 'No currency' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid customer_type (400)', async () => {
    const res = await request(app).post('/api/customers').set(hdr(salesUser))
      .send({ customerCode: `${customerCode}-Z`, customerName: 'Bad type', defaultCurrencyId: currencyId, customerType: 'WRONG' });
    expect(res.status).toBe(400);
  });

  it('maps a duplicate customer_code to a 409 conflict', async () => {
    const res = await request(app).post('/api/customers').set(hdr(salesUser))
      .send({ customerCode, customerName: 'Dup', defaultCurrencyId: currencyId });
    expect(res.status).toBe(409);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(401);
  });

  it('lists customers (200) with ?q and fetches one (200), 404 on an unknown id', async () => {
    const list = await request(app).get(`/api/customers?q=${customerCode}`).set(hdr(salesUser));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const ok = await request(app).get(`/api/customers/${createdId}`).set(hdr(salesUser));
    expect(ok.status).toBe(200);
    expect(ok.body.customerCode).toBe(customerCode);

    const no = await request(app).get('/api/customers/99999999').set(hdr(salesUser));
    expect(no.status).toBe(404);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    // First edit bumps the row version, so the original is now stale.
    const ok = await request(app).patch(`/api/customers/${createdId}`).set(hdr(salesUser))
      .send({ customerName: 'Acme Steel v2', status: 'HOLD', rowVersion: createdVersion });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('HOLD');
    createdVersion = ok.body.rowVersion;

    const stale = await request(app).patch(`/api/customers/${createdId}`).set(hdr(salesUser))
      .send({ customerName: 'Acme Steel v3', rowVersion: createdVersion - 1 });
    expect(stale.status).toBe(409);
  });

  it('denies delete without CUSTOMER.DELETE (sales -> 403)', async () => {
    const res = await request(app).delete(`/api/customers/${createdId}?rowVersion=${createdVersion}`).set(hdr(salesUser));
    expect(res.status).toBe(403);
  });

  it('soft-deletes as admin_user (204), then the row is gone (404)', async () => {
    const del = await request(app).delete(`/api/customers/${createdId}?rowVersion=${createdVersion}`).set(hdr(adminUser));
    expect(del.status).toBe(204);

    const gone = await request(app).get(`/api/customers/${createdId}`).set(hdr(salesUser));
    expect(gone.status).toBe(404);
  });
});
