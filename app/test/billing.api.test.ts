import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { billingRouter } from '../src/modules/billing/billing.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts billingRouter at /api/invoices exactly as the composition root
 * does (createApp wires `app.use('/api/invoices', billingRouter(pool))`); here we
 * mount a minimal equivalent so the module is testable independently of app.ts.
 *
 * AR / Billing: FINANCE holds INVOICE.VCEDAX (full); SALES holds INVOICE.V (read
 * only -> 200 read, 403 create); STORES holds NO INVOICE permission (403 even on
 * read). Invoice financials are computed server-side from the lines.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/invoices', billingRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Billing/AR API (integration) — invoices, receipts, retention, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let financeUser: number;
  let salesUser: number;
  let storesUser: number;
  let projectId: number;
  let customerId: number;
  let currencyId: number;

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
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    storesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='stores_user'`)).user_id);

    // Master data the invoice references (customer_id + currency_id are NOT NULL FKs
    // on fin.invoice; project_id is a NOT NULL FK on fin.retention). The test connects
    // as the owning superuser, so RLS does not filter these inserts. A pm_user_id is
    // required on proj.project.
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    currencyId = Number((await one(`SELECT currency_id FROM mdm.currency WHERE iso_code='INR'`)).currency_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-BILL-TEST', 'Billing Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, financeUser]);
    projectId = Number(proj.project_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates an invoice (201) with an auto-generated INV number, in DRAFT, amounts computed', async () => {
    const res = await request(app).post('/api/invoices').set(hdr(financeUser)).send({
      customerId, projectId, currencyId,
      lines: [{ description: 'Pump skid assembly', qty: 2, unitRate: 500 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.invoiceNo).toMatch(/^INV\//);
    expect(res.body.status).toBe('DRAFT');
    // 2 x 500 = 1000 taxable, no tax code -> tax 0, total 1000.
    expect(Number(res.body.taxableAmount)).toBe(1000);
    expect(Number(res.body.taxAmount)).toBe(0);
    expect(Number(res.body.totalAmount)).toBe(1000);
    expect(res.body.lines).toHaveLength(1);
    createdId = res.body.invoiceId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without INVOICE.CREATE (sales -> 403, view-only)', async () => {
    const res = await request(app).post('/api/invoices').set(hdr(salesUser)).send({
      customerId, lines: [{ description: 'X', qty: 1, unitRate: 100 }],
    });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): no lines / bad date', async () => {
    const r1 = await request(app).post('/api/invoices').set(hdr(financeUser)).send({ customerId, lines: [] });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/invoices').set(hdr(financeUser))
      .send({ customerId, invoiceDate: 'not-a-date', lines: [{ description: 'X', qty: 1, unitRate: 1 }] });
    expect(r2.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(401);
  });

  it('denies read to a role without INVOICE.VIEW (stores -> 403)', async () => {
    const res = await request(app).get('/api/invoices').set(hdr(storesUser));
    expect(res.status).toBe(403);
  });

  it('lists invoices (200) and allows the SALES view-only role to read', async () => {
    const res = await request(app).get('/api/invoices?status=DRAFT').set(hdr(financeUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asSales = await request(app).get('/api/invoices').set(hdr(salesUser));
    expect(asSales.status).toBe(200);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/invoices/${createdId}`).set(hdr(financeUser));
    expect(ok.status).toBe(200);
    expect(ok.body.customerId).toBe(customerId);
    const no = await request(app).get('/api/invoices/99999999').set(hdr(financeUser));
    expect(no.status).toBe(404);
  });

  it('posts the invoice (200, status POSTED) and records the invoice.posted outbox event', async () => {
    const res = await request(app).post(`/api/invoices/${createdId}/post`).set(hdr(financeUser))
      .send({ rowVersion: createdVersion });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('POSTED');
    createdVersion = res.body.rowVersion;

    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='INVOICE' AND aggregate_id=$1 AND event_type='invoice.posted'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.invoiceNo).toMatch(/^INV\//);
    expect(Number(evt.rows[0].payload.totalAmount)).toBe(1000);
  });

  it('records a receipt with a partial allocation -> invoice becomes PARTIALLY_PAID', async () => {
    const res = await request(app).post('/api/invoices/receipts').set(hdr(financeUser)).send({
      customerId, amount: 400, mode: 'NEFT', reference: 'UTR-PARTIAL',
      allocations: [{ invoiceId: createdId, allocatedAmount: 400 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.receiptNo).toMatch(/^RCT\//);
    expect(res.body.allocations).toHaveLength(1);

    const inv = await request(app).get(`/api/invoices/${createdId}`).set(hdr(financeUser));
    expect(inv.body.status).toBe('PARTIALLY_PAID');
    createdVersion = inv.body.rowVersion;
  });

  it('rejects an over-allocation beyond the outstanding balance (400)', async () => {
    // 1000 total, 400 already paid -> only 600 outstanding; ask for 700.
    const res = await request(app).post('/api/invoices/receipts').set(hdr(financeUser)).send({
      customerId, amount: 700,
      allocations: [{ invoiceId: createdId, allocatedAmount: 700 }],
    });
    expect(res.status).toBe(400);
  });

  it('settles the remaining balance -> invoice becomes PAID', async () => {
    const res = await request(app).post('/api/invoices/receipts').set(hdr(financeUser)).send({
      customerId, amount: 600, mode: 'NEFT', reference: 'UTR-FINAL',
      allocations: [{ invoiceId: createdId, allocatedAmount: 600 }],
    });
    expect(res.status).toBe(201);
    const inv = await request(app).get(`/api/invoices/${createdId}`).set(hdr(financeUser));
    expect(inv.body.status).toBe('PAID');
  });

  it('creates + releases retention (HELD -> PARTIAL -> RELEASED)', async () => {
    const created = await request(app).post('/api/invoices/retentions').set(hdr(financeUser)).send({
      projectId, retainedAmount: 1000,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('HELD');
    const retId = created.body.retentionId;

    const partial = await request(app).post(`/api/invoices/retentions/${retId}/release`).set(hdr(financeUser))
      .send({ amount: 400 });
    expect(partial.status).toBe(200);
    expect(partial.body.status).toBe('PARTIAL');
    expect(Number(partial.body.releasedAmount)).toBe(400);

    const full = await request(app).post(`/api/invoices/retentions/${retId}/release`).set(hdr(financeUser))
      .send({ amount: 600 });
    expect(full.status).toBe(200);
    expect(full.body.status).toBe('RELEASED');
  });

  it('409 on a stale row version (optimistic concurrency on post)', async () => {
    const create = await request(app).post('/api/invoices').set(hdr(financeUser)).send({
      customerId, lines: [{ description: 'Stale-test line', qty: 1, unitRate: 100 }],
    });
    expect(create.status).toBe(201);
    const id = create.body.invoiceId;
    // post once so the original version is now stale
    const posted = await request(app).post(`/api/invoices/${id}/post`).set(hdr(financeUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(posted.status).toBe(200);
    // markSent with the now-stale create version -> 409
    const stale = await request(app).post(`/api/invoices/${id}/send`).set(hdr(financeUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });

  // -------------------------------------------------------------------
  // One-click "Raise Invoice from a project" — POST /from-project/:projectId.
  // Pre-fills customer (from the project) + currency (the customer's default) and
  // a line from either the next PENDING billing milestone or the contract value.
  // -------------------------------------------------------------------
  it('raises a DRAFT invoice from a project with NO milestone — placeholder line from contract_value', async () => {
    // Dedicated project carrying a contract_value but no billing milestone.
    const proj = await pool.query(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status, contract_value)
       VALUES ($1, 'PRJ-BILL-FP1', 'From-Project (no milestone)', $2, $3, 'ACTIVE', 7500)
       ON CONFLICT (project_no) DO UPDATE SET contract_value = EXCLUDED.contract_value
       RETURNING project_id`, [companyId, customerId, financeUser]);
    const pid = Number(proj.rows[0].project_id);

    const res = await request(app).post(`/api/invoices/from-project/${pid}`).set(hdr(financeUser)).send({});
    expect(res.status).toBe(201);
    expect(res.body.invoiceNo).toMatch(/^INV\//);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.customerId).toBe(customerId); // inferred from the project
    expect(res.body.currencyId).toBe(currencyId); // inferred from the customer's default
    expect(res.body.projectId).toBe(pid);
    expect(res.body.milestoneId).toBeNull(); // no billing milestone -> placeholder line
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].description).toBe('Project PRJ-BILL-FP1');
    expect(Number(res.body.lines[0].unitRate)).toBe(7500);
    expect(Number(res.body.totalAmount)).toBe(7500);
  });

  it('raises a DRAFT invoice from a project WITH a pending proj.milestone — line + milestoneId from it', async () => {
    const proj = await pool.query(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status, contract_value)
       VALUES ($1, 'PRJ-BILL-FP2', 'From-Project (milestone)', $2, $3, 'ACTIVE', 99999)
       ON CONFLICT (project_no) DO UPDATE SET contract_value = EXCLUDED.contract_value
       RETURNING project_id`, [companyId, customerId, financeUser]);
    const pid = Number(proj.rows[0].project_id);
    // A PENDING payment milestone — its name/bill_amount drive the single line and
    // its id (a proj.milestone FK target) is stamped on the invoice. Seed
    // idempotently: reuse the existing milestone on a repeat run (a prior run's
    // invoice references it via fin.invoice.milestone_id, so it cannot be deleted),
    // which also keeps the expected milestone_id stable.
    const existing = await pool.query(
      `SELECT milestone_id FROM proj.milestone
        WHERE project_id = $1 AND name = 'Advance on PO' ORDER BY milestone_id LIMIT 1`, [pid]);
    const milestoneId = existing.rowCount
      ? Number(existing.rows[0].milestone_id)
      : Number((await pool.query(
        `INSERT INTO proj.milestone (company_id, project_id, name, is_payment_milestone, bill_amount, status)
         VALUES ($1, $2, 'Advance on PO', true, 2500, 'PENDING') RETURNING milestone_id`,
        [companyId, pid])).rows[0].milestone_id);

    const res = await request(app).post(`/api/invoices/from-project/${pid}`).set(hdr(financeUser)).send({});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.projectId).toBe(pid);
    expect(res.body.milestoneId).toBe(milestoneId); // stamped from the milestone
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].description).toBe('Advance on PO');
    expect(Number(res.body.lines[0].unitRate)).toBe(2500);
    expect(Number(res.body.totalAmount)).toBe(2500); // 1 x 2500, no tax
  });

  it('404s when the project does not exist', async () => {
    const res = await request(app).post('/api/invoices/from-project/99999999').set(hdr(financeUser)).send({});
    expect(res.status).toBe(404);
  });

  it('denies from-project without INVOICE.CREATE (sales -> 403, view-only)', async () => {
    const res = await request(app).post(`/api/invoices/from-project/${projectId}`).set(hdr(salesUser)).send({});
    expect(res.status).toBe(403);
  });
});
