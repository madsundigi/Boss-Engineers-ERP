import { Pool } from 'pg';
import { OutboxRecord } from '../src/outbox/outbox';
import {
  invoicePostedGlHandler, paymentReceivedGlHandler, vendorInvoiceApprovedGlHandler,
} from '../src/modules/gl/gl.handlers';

/**
 * Integration tests — the finance subledger -> General Ledger auto-posting
 * handlers (src/modules/gl/gl.handlers.ts) against a real database. Runs only
 * when DATABASE_URL is set (provisioned by the test harness) so the suite is a
 * no-op without a database, exactly like dispatch.api.test.ts.
 *
 * Each test inserts a subledger source row directly (as the owning superuser, so
 * RLS does not filter the insert) and synthesises the OutboxRecord the relay
 * would hand the handler, then asserts the resulting balanced fin.gl_entry — and
 * that a SECOND delivery of the same record posts NOTHING (idempotency, keyed on
 * source_doc_type + source_doc_id).
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

d('Finance -> GL auto-posting (integration) — balanced journals + idempotency', () => {
  let pool: Pool;
  let companyId: number;
  let buId: number;
  let financeUser: number;
  let customerId: number;
  let vendorId: number;
  let currencyId: number;
  let projectId: number;

  const one = async (sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows[0];

  /** Build the OutboxRecord the relay would deliver for a committed event. */
  const record = (eventType: string, aggregateId: number): OutboxRecord => ({
    eventId: Math.floor(Math.random() * 1e9), eventType, aggregateType: 'X',
    aggregateId, companyId, payload: {}, attempts: 0, maxAttempts: 5, createdBy: financeUser,
  });

  /** Header + summed lines of the journal posted for a given source document. */
  const journalFor = async (sourceDocType: string, sourceDocId: number) => {
    const head = await one(
      `SELECT gl_entry_id, posting_date, narration
         FROM fin.gl_entry
        WHERE company_id = $1 AND source_doc_type = $2 AND source_doc_id = $3`,
      [companyId, sourceDocType, sourceDocId]);
    if (!head) return null;
    const lines = (await pool.query(
      `SELECT l.gl_id, a.gl_code, l.debit, l.credit, l.project_id
         FROM fin.gl_entry_line l JOIN mdm.gl_account a ON a.gl_id = l.gl_id
        WHERE l.gl_entry_id = $1 AND l.posting_date = $2
        ORDER BY l.gl_line_id`,
      [head.gl_entry_id, head.posting_date])).rows;
    return { head, lines };
  };

  const countJournals = async (sourceDocType: string, sourceDocId: number): Promise<number> =>
    Number((await one(
      `SELECT count(*)::text c FROM fin.gl_entry
        WHERE company_id = $1 AND source_doc_type = $2 AND source_doc_id = $3`,
      [companyId, sourceDocType, sourceDocId])).c);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    financeUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='finance_user'`)).user_id);
    customerId = Number((await one(`SELECT customer_id FROM mdm.customer WHERE customer_code='CUST-TEST' AND company_id=$1`, [companyId])).customer_id);
    vendorId = Number((await one(`SELECT vendor_id FROM mdm.vendor WHERE vendor_code='VEND-TEST' AND company_id=$1`, [companyId])).vendor_id);
    currencyId = Number((await one(`SELECT currency_id FROM mdm.currency WHERE iso_code='INR'`)).currency_id);

    const proj = await one(
      `INSERT INTO proj.project (company_id, project_no, project_name, customer_id, pm_user_id, status)
       VALUES ($1, 'PRJ-GLPOST-TEST', 'GL Posting Test Project', $2, $3, 'ACTIVE')
       ON CONFLICT (project_no) DO UPDATE SET project_name = EXCLUDED.project_name
       RETURNING project_id`, [companyId, customerId, financeUser]);
    projectId = Number(proj.project_id);

    // The standard chart of accounts is seeded by migration 024; assert it is
    // present so a missing seed fails loudly here rather than mid-posting.
    const acctCount = Number((await one(
      `SELECT count(*)::text c FROM mdm.gl_account
        WHERE company_id = $1 AND gl_code IN ('1000','1200','2100','2110','4000','5000')`,
      [companyId])).c);
    expect(acctCount).toBe(6);
  });

  afterAll(async () => { await pool.end(); });

  it('invoice.posted -> Dr AR, Cr Revenue + GST; balanced; project on revenue line; idempotent', async () => {
    // POSTED AR invoice with tax: 10000 taxable + 1800 GST = 11800 total.
    const inv = await one(
      `INSERT INTO fin.invoice
         (company_id, bu_id, invoice_no, project_id, customer_id, invoice_date,
          currency_id, taxable_amount, tax_amount, total_amount, status, created_by)
       VALUES ($1,$2,$3,$4,$5, current_date, $6, 10000, 1800, 11800, 'POSTED', $7)
       RETURNING invoice_id`,
      [companyId, buId, `INV-GLTEST-${Date.now()}`, projectId, customerId, currencyId, financeUser]);
    const invoiceId = Number(inv.invoice_id);

    const rec = record('invoice.posted', invoiceId);
    await invoicePostedGlHandler(pool)(rec);

    const journal = await journalFor('INVOICE', invoiceId);
    expect(journal).not.toBeNull();
    const { lines } = journal!;
    const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBe(11800);
    expect(credit).toBe(11800); // balanced

    const ar = lines.find((l) => l.gl_code === '1200')!;
    const rev = lines.find((l) => l.gl_code === '4000')!;
    const gst = lines.find((l) => l.gl_code === '2110')!;
    expect(Number(ar.debit)).toBe(11800);
    expect(Number(rev.credit)).toBe(10000);
    expect(Number(gst.credit)).toBe(1800);
    expect(Number(rev.project_id)).toBe(projectId); // project on the revenue line

    // Re-deliver the SAME event: must NOT post a second journal (idempotency).
    await invoicePostedGlHandler(pool)(rec);
    expect(await countJournals('INVOICE', invoiceId)).toBe(1);
  });

  it('invoice.posted with zero tax omits the GST line (still balanced)', async () => {
    const inv = await one(
      `INSERT INTO fin.invoice
         (company_id, bu_id, invoice_no, project_id, customer_id, invoice_date,
          currency_id, taxable_amount, tax_amount, total_amount, status, created_by)
       VALUES ($1,$2,$3,$4,$5, current_date, $6, 5000, 0, 5000, 'POSTED', $7)
       RETURNING invoice_id`,
      [companyId, buId, `INV-GLNOTAX-${Date.now()}`, projectId, customerId, currencyId, financeUser]);
    const invoiceId = Number(inv.invoice_id);

    await invoicePostedGlHandler(pool)(record('invoice.posted', invoiceId));

    const { lines } = (await journalFor('INVOICE', invoiceId))!;
    expect(lines).toHaveLength(2); // AR + Revenue only, no GST line
    expect(lines.some((l) => l.gl_code === '2110')).toBe(false);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0)).toBe(5000);
    expect(lines.reduce((s, l) => s + Number(l.credit), 0)).toBe(5000);
  });

  it('payment.received -> Dr Bank, Cr AR; balanced; idempotent', async () => {
    const rc = await one(
      `INSERT INTO fin.payment_receipt
         (company_id, receipt_no, customer_id, receipt_date, amount)
       VALUES ($1,$2,$3, current_date, 7500)
       RETURNING receipt_id`,
      [companyId, `RCT-GLTEST-${Date.now()}`, customerId]);
    const receiptId = Number(rc.receipt_id);

    const rec = record('payment.received', receiptId);
    await paymentReceivedGlHandler(pool)(rec);

    const { lines } = (await journalFor('RECEIPT', receiptId))!;
    const bank = lines.find((l) => l.gl_code === '1000')!;
    const ar = lines.find((l) => l.gl_code === '1200')!;
    expect(Number(bank.debit)).toBe(7500);
    expect(Number(ar.credit)).toBe(7500);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0))
      .toBe(lines.reduce((s, l) => s + Number(l.credit), 0)); // balanced

    await paymentReceivedGlHandler(pool)(rec);
    expect(await countJournals('RECEIPT', receiptId)).toBe(1); // idempotent
  });

  it('vendor_invoice.approved -> Dr COGS, Cr AP; balanced; idempotent', async () => {
    const vi = await one(
      `INSERT INTO fin.vendor_invoice
         (company_id, vinv_no, vendor_id, invoice_date, total_amount, status)
       VALUES ($1,$2,$3, current_date, 4200, 'APPROVED')
       RETURNING vendor_invoice_id`,
      [companyId, `VINV-GLTEST-${Date.now()}`, vendorId]);
    const vendorInvoiceId = Number(vi.vendor_invoice_id);

    const rec = record('vendor_invoice.approved', vendorInvoiceId);
    await vendorInvoiceApprovedGlHandler(pool)(rec);

    const { lines } = (await journalFor('VENDOR_INVOICE', vendorInvoiceId))!;
    const cogs = lines.find((l) => l.gl_code === '5000')!;
    const ap = lines.find((l) => l.gl_code === '2100')!;
    expect(Number(cogs.debit)).toBe(4200);
    expect(Number(ap.credit)).toBe(4200);
    expect(lines.reduce((s, l) => s + Number(l.debit), 0))
      .toBe(lines.reduce((s, l) => s + Number(l.credit), 0)); // balanced

    await vendorInvoiceApprovedGlHandler(pool)(rec);
    expect(await countJournals('VENDOR_INVOICE', vendorInvoiceId)).toBe(1); // idempotent
  });

  it('returns early (no posting) when aggregateId is null', async () => {
    const rec: OutboxRecord = { ...record('invoice.posted', 0), aggregateId: null };
    await expect(invoicePostedGlHandler(pool)(rec)).resolves.toBeUndefined();
  });
});
