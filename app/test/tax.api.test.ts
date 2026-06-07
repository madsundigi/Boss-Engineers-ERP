import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { taxRouter } from '../src/modules/tax/tax.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts taxRouter at /api/tax exactly as the composition root does
 * (createApp wires `app.use('/api/tax', taxRouter(pool))`); here we mount a
 * minimal equivalent so the module is testable independently of app.ts.
 *
 * GST / Tax: FINANCE has the full TAX surface (TAX.VCEDAX); CEO is view/export
 * only (TAX.VX -> 403 on create); SALES has no TAX permission (403). The AR
 * Billing module owns fin.invoice creation, so to stay disjoint we INSERT the
 * invoice rows directly via SQL in beforeAll (the test connects as the owning
 * superuser, bypassing RLS).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/tax', taxRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Tax API (integration) — tax codes, e-invoice (IRN), e-way bill, GST summary, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let financeUser: number;
  let salesUser: number;
  let ceoUser: number;
  let customerId: number;
  let currencyId: number;
  let einvInvoiceId: number; // the invoice we e-invoice (then e-way bill)
  let ewayInvoiceId: number; // a fresh invoice for the "e-way before e-invoice -> 409" path

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  // Insert a POSTED fin.invoice directly (Billing owns this table; we connect as
  // the owning superuser so RLS does not filter the insert). Returns invoice_id.
  const seedInvoice = async (invoiceNo: string): Promise<number> => {
    const res = await pool.query(
      `INSERT INTO fin.invoice
         (company_id, invoice_no, customer_id, invoice_date, currency_id,
          taxable_amount, tax_amount, total_amount, status)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, 100000, 18000, 118000, 'POSTED')
       RETURNING invoice_id`,
      [companyId, invoiceNo, customerId, currencyId]);
    return Number(res.rows[0].invoice_id);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
    ceoUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='ceo_user'`)).user_id);
    customerId = Number((await one(
      `SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    currencyId = Number((await one(`SELECT currency_id FROM mdm.currency WHERE iso_code='INR'`)).currency_id);

    // Two invoices (unique invoice_no per run so re-runs don't collide on the UNIQUE).
    const suffix = Date.now().toString().slice(-6);
    einvInvoiceId = await seedInvoice(`INV/TEST/EINV/${suffix}`);
    ewayInvoiceId = await seedInvoice(`INV/TEST/EWAY/${suffix}`);
  });

  afterAll(async () => { await pool.end(); });

  // unique tax code per run (mdm.tax_code.code is globally UNIQUE)
  const taxCodeStr = `GST18-${Date.now().toString().slice(-6)}`;

  // --- Tax-code master ---
  it('creates a tax code (201) as FINANCE', async () => {
    const res = await request(app).post('/api/tax/codes').set(hdr(financeUser))
      .send({ code: taxCodeStr, cgstRate: 9, sgstRate: 9, igstRate: 18 });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe(taxCodeStr);
    expect(res.body.cgstRate).toBe(9);
    expect(res.body.isActive).toBe(true);
  });

  it('denies create without TAX.CREATE (sales -> 403)', async () => {
    const res = await request(app).post('/api/tax/codes').set(hdr(salesUser))
      .send({ code: `${taxCodeStr}-X`, cgstRate: 9, sgstRate: 9 });
    expect(res.status).toBe(403);
  });

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/tax/codes');
    expect(res.status).toBe(401);
  });

  it('409 on a duplicate tax code', async () => {
    const res = await request(app).post('/api/tax/codes').set(hdr(financeUser))
      .send({ code: taxCodeStr, cgstRate: 9, sgstRate: 9 });
    expect(res.status).toBe(409);
  });

  it('lists tax codes (200) and allows the CEO view-only role to read', async () => {
    const asFinance = await request(app).get('/api/tax/codes?isActive=true').set(hdr(financeUser));
    expect(asFinance.status).toBe(200);
    expect(Array.isArray(asFinance.body)).toBe(true);
    const asCeo = await request(app).get('/api/tax/codes').set(hdr(ceoUser));
    expect(asCeo.status).toBe(200);
  });

  // --- E-invoice (IRN) ---
  it('denies e-invoice generation to CEO (view/export only -> 403)', async () => {
    const res = await request(app).post(`/api/tax/invoices/${einvInvoiceId}/einvoice`).set(hdr(ceoUser))
      .send({ supplyType: 'INTRA' });
    expect(res.status).toBe(403);
  });

  it('generates an e-invoice (201) for a POSTED invoice: 64-char IRN, ledger row, outbox event', async () => {
    const res = await request(app).post(`/api/tax/invoices/${einvInvoiceId}/einvoice`).set(hdr(financeUser))
      .send({ supplyType: 'INTRA' });
    expect(res.status).toBe(201);
    expect(res.body.irn).toHaveLength(64);
    expect(res.body.ackNo).toMatch(/^ACK/);
    // INTRA split: cgst == sgst == tax/2, igst 0.
    expect(res.body.cgst).toBe(9000);
    expect(res.body.sgst).toBe(9000);
    expect(res.body.igst).toBe(0);

    // a fin.tax_transaction ledger row exists for the invoice with cgst+sgst == 18000.
    const led = await pool.query(
      `SELECT taxable_amount, cgst, sgst, igst FROM fin.tax_transaction
        WHERE doc_type='INVOICE' AND doc_id=$1`, [einvInvoiceId]);
    expect(led.rowCount).toBe(1);
    expect(Number(led.rows[0].cgst) + Number(led.rows[0].sgst)).toBe(18000);
    expect(Number(led.rows[0].taxable_amount)).toBe(100000);

    // the invoice was stamped with the IRN + ack number.
    const inv = await pool.query(`SELECT irn, ack_no FROM fin.invoice WHERE invoice_id=$1`, [einvInvoiceId]);
    expect(inv.rows[0].irn).toHaveLength(64);
    expect(inv.rows[0].ack_no).not.toBeNull();

    // the generation recorded a transactional-outbox event.
    const evt = await pool.query(
      `SELECT event_type, payload FROM mdm.outbox_event
        WHERE aggregate_type='INVOICE' AND aggregate_id=$1 AND event_type='einvoice.generated'`,
      [einvInvoiceId]);
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].payload.irn).toHaveLength(64);
    expect(Number(evt.rows[0].payload.totalTax)).toBe(18000);
  });

  it('409 on a second e-invoice for the same invoice (already stamped)', async () => {
    const res = await request(app).post(`/api/tax/invoices/${einvInvoiceId}/einvoice`).set(hdr(financeUser))
      .send({ supplyType: 'INTRA' });
    expect(res.status).toBe(409);
  });

  // --- E-way bill ---
  it('409 generating an e-way bill before the invoice is e-invoiced', async () => {
    const res = await request(app).post(`/api/tax/invoices/${ewayInvoiceId}/ewaybill`).set(hdr(financeUser))
      .send({ transporter: 'BlueDart' });
    expect(res.status).toBe(409);
  });

  it('generates an e-way bill (201) after the invoice has an IRN; sets eway_bill_no', async () => {
    const res = await request(app).post(`/api/tax/invoices/${einvInvoiceId}/ewaybill`).set(hdr(financeUser))
      .send({ transporter: 'BlueDart', vehicleNo: 'MH01AB1234' });
    expect(res.status).toBe(201);
    expect(res.body.ewayBillNo).toMatch(/^\d{12}$/);

    const inv = await pool.query(`SELECT eway_bill_no FROM fin.invoice WHERE invoice_id=$1`, [einvInvoiceId]);
    expect(inv.rows[0].eway_bill_no).toBe(res.body.ewayBillNo);

    const evt = await pool.query(
      `SELECT event_type FROM mdm.outbox_event
        WHERE aggregate_type='INVOICE' AND aggregate_id=$1 AND event_type='eway_bill.generated'`,
      [einvInvoiceId]);
    expect(evt.rowCount).toBe(1);
  });

  // --- Reads ---
  it('returns the GST summary (200) with period totals', async () => {
    const res = await request(app)
      .get('/api/tax/summary?fromDate=2000-01-01&toDate=2100-12-31').set(hdr(financeUser));
    expect(res.status).toBe(200);
    expect(Number(res.body.taxableAmount)).toBeGreaterThanOrEqual(100000);
    expect(Number(res.body.cgst) + Number(res.body.sgst) + Number(res.body.igst))
      .toBe(Number(res.body.totalTax));
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  it('lists GST transactions (200, paginated)', async () => {
    const res = await request(app).get('/api/tax/transactions?docType=INVOICE').set(hdr(financeUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });
});
