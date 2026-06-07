import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { payablesRouter } from '../src/modules/payables/payables.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts payablesRouter at /api/ap-invoices exactly as the composition
 * root does (createApp wires `app.use('/api/ap-invoices', payablesRouter(pool))`);
 * here we mount a minimal equivalent so the module is testable independently of
 * app.ts.
 *
 * Accounts Payable: FINANCE owns the full lifecycle (AP_INVOICE.VCEDAX) — create,
 * match, approve, pay, dispute, delete, export; PURCHASE is view-only (200 read,
 * 403 create); SALES has NO AP permission (403 even on read). The vendor invoice
 * number (vinv_no) is the supplier's own number, supplied by the user; only the
 * payment is auto-numbered ('VPY' series).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/ap-invoices', payablesRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Accounts Payable API (integration) — vendor invoices, payments, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let financeUser: number;
  let purchaseUser: number;
  let salesUser: number;
  let vendorId: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  // A unique supplier invoice number per create (uq_vendor_invoice is per vendor+vinv_no).
  const vinv = () => `SUPP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    purchaseUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='purchase_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);

    // The vendor the bill references (vendor_id is a NOT NULL FK on fin.vendor_invoice).
    // 'VEND-TEST' is provisioned by the test seed (app/test/seed.sql). The test connects
    // as the owning superuser, so RLS does not filter this read.
    vendorId = Number((await one(
      `SELECT vendor_id FROM mdm.vendor WHERE vendor_code='VEND-TEST' AND company_id=$1`, [companyId])).vendor_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;
  let createdVersion: number;

  it('creates a vendor invoice (201) in PENDING with a user-supplied vinv_no + a line; total computed', async () => {
    const res = await request(app).post('/api/ap-invoices').set(hdr(financeUser)).send({
      vinvNo: vinv(), vendorId,
      lines: [{ amount: 600 }, { amount: 400 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.vinvNo).toMatch(/^SUPP-/);
    expect(Number(res.body.totalAmount)).toBe(1000);
    expect(res.body.lines).toHaveLength(2);
    createdId = res.body.vendorInvoiceId;
    createdVersion = res.body.rowVersion;
  });

  it('denies create without AP_INVOICE.CREATE (purchase is view-only -> 403)', async () => {
    const res = await request(app).post('/api/ap-invoices').set(hdr(purchaseUser))
      .send({ vinvNo: vinv(), vendorId, lines: [{ amount: 100 }] });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body (400): missing vinv_no', async () => {
    const res = await request(app).post('/api/ap-invoices').set(hdr(financeUser))
      .send({ vendorId, lines: [{ amount: 100 }] });
    expect(res.status).toBe(400);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/ap-invoices');
    expect(res.status).toBe(401);
  });

  it('lists vendor invoices (200) and allows the PURCHASE view-only role to read', async () => {
    const res = await request(app).get('/api/ap-invoices?status=PENDING').set(hdr(financeUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const asPurchase = await request(app).get('/api/ap-invoices').set(hdr(purchaseUser));
    expect(asPurchase.status).toBe(200);
  });

  it('denies all access to a role without any AP permission (sales -> 403 even on read)', async () => {
    const res = await request(app).get('/api/ap-invoices').set(hdr(salesUser));
    expect(res.status).toBe(403);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/ap-invoices/${createdId}`).set(hdr(financeUser));
    expect(ok.status).toBe(200);
    expect(ok.body.vendorId).toBe(vendorId);
    const no = await request(app).get('/api/ap-invoices/99999999').set(hdr(financeUser));
    expect(no.status).toBe(404);
  });

  it('runs the happy path match -> approve and records the approved outbox event', async () => {
    const match = await request(app).post(`/api/ap-invoices/${createdId}/match`).set(hdr(financeUser))
      .send({ rowVersion: createdVersion });
    expect(match.status).toBe(200);
    expect(match.body.status).toBe('MATCHED');

    const approve = await request(app).post(`/api/ap-invoices/${createdId}/approve`).set(hdr(financeUser))
      .send({ rowVersion: match.body.rowVersion });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('APPROVED');
    createdVersion = approve.body.rowVersion;

    // the approval recorded a transactional-outbox event for downstream consumers.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='VENDOR_INVOICE' AND aggregate_id=$1 AND event_type='vendor_invoice.approved'`,
      [createdId]);
    expect(evt.rowCount).toBe(1);
    expect(Number(evt.rows[0].payload.totalAmount)).toBe(1000);
  });

  it('records a payment (vpay_no /^VPY\\//) that fully settles the bill and drives it to PAID', async () => {
    const pay = await request(app).post('/api/ap-invoices/payments').set(hdr(financeUser))
      .send({ vendorInvoiceId: createdId, amount: 1000 });
    expect(pay.status).toBe(201);
    expect(pay.body.vpayNo).toMatch(/^VPY\//);
    expect(Number(pay.body.amount)).toBe(1000);

    const after = await request(app).get(`/api/ap-invoices/${createdId}`).set(hdr(financeUser));
    expect(after.body.status).toBe('PAID');
  });

  it('rejects a payment over the outstanding balance (400)', async () => {
    // a fresh invoice taken through to APPROVED, total 500
    const create = await request(app).post('/api/ap-invoices').set(hdr(financeUser))
      .send({ vinvNo: vinv(), vendorId, lines: [{ amount: 500 }] });
    const id = create.body.vendorInvoiceId;
    const match = await request(app).post(`/api/ap-invoices/${id}/match`).set(hdr(financeUser))
      .send({ rowVersion: create.body.rowVersion });
    const approve = await request(app).post(`/api/ap-invoices/${id}/approve`).set(hdr(financeUser))
      .send({ rowVersion: match.body.rowVersion });
    expect(approve.status).toBe(200);

    const over = await request(app).post('/api/ap-invoices/payments').set(hdr(financeUser))
      .send({ vendorInvoiceId: id, amount: 600 }); // 600 > 500
    expect(over.status).toBe(400);
  });

  it('409 on a stale row version (optimistic concurrency)', async () => {
    const create = await request(app).post('/api/ap-invoices').set(hdr(financeUser))
      .send({ vinvNo: vinv(), vendorId, lines: [{ amount: 100 }] });
    expect(create.status).toBe(201);
    const id = create.body.vendorInvoiceId;
    // match once so the original version is now stale
    const ok = await request(app).post(`/api/ap-invoices/${id}/match`).set(hdr(financeUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(ok.status).toBe(200);
    // re-using the original (now stale) version must conflict
    const stale = await request(app).post(`/api/ap-invoices/${id}/approve`).set(hdr(financeUser))
      .send({ rowVersion: create.body.rowVersion });
    expect(stale.status).toBe(409);
  });
});
