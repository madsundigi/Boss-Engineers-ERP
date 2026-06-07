import { Pool } from 'pg';
import { OutboxHandler, OutboxRecord, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { runRead } from '../../db/pool';
import { GlRepository, JournalInput } from './gl.repository';
import { GL_JOURNAL_POSTED_EVENT } from './gl.constants';

/**
 * Finance subledger -> General Ledger auto-posting.
 *
 * Each of the three factories returns an OutboxHandler that the relay invokes
 * AFTER a finance subledger event has committed (invoice posted / receipt
 * recorded / vendor invoice approved). The handler posts a BALANCED double-entry
 * journal to the GL by reusing GlRepository.postJournal — no journal SQL is
 * reimplemented here.
 *
 * The relay re-delivers on failure, so every handler MUST be idempotent. The
 * idempotency key is (source_doc_type, source_doc_id): before posting we check
 * for an existing fin.gl_entry stamped with that pair and bail if one is found,
 * so a re-delivered event never double-posts.
 *
 * Accounts are resolved by stable gl_code (seeded by migration 024); a missing
 * required account is a hard error (throw) so the event retries / dead-letters
 * loudly rather than silently skipping a financial posting.
 */

/** source_doc_type stamps used as the per-document idempotency key on fin.gl_entry. */
const DOC_INVOICE = 'INVOICE';
const DOC_RECEIPT = 'RECEIPT';
const DOC_VENDOR_INVOICE = 'VENDOR_INVOICE';

/** Money is numeric(20,4); round to 4dp so debit/credit equality is exact. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** A non-interactive, tenant-scoped context for an outbox handler (mirrors the
 *  quotation handler). buId is filled in by the caller — the GL post needs it
 *  for journal numbering (mdm.next_document_no). */
function systemContext(e: OutboxRecord, buId: number | null): RequestContext {
  return {
    userId: e.createdBy ?? 0, username: 'system', companyId: e.companyId ?? 0,
    buId, clientIp: '0.0.0.0', sessionId: `outbox-${e.eventId}`, permissions: new Set(),
  };
}

/** The transactional-outbox event postJournal emits atomically with the inserts
 *  (the GL repo requires one); mirrors GlService.postedEvent's shape. */
function postedEvent(ctx: RequestContext, j: JournalInput): OutboxEventInput {
  return {
    eventType: GL_JOURNAL_POSTED_EVENT,
    aggregateType: 'GL_ENTRY',
    aggregateId: null, // gl_entry_id is allocated in the same tx; not known here
    companyId: ctx.companyId,
    createdBy: ctx.userId,
    payload: {
      journalNo: null,
      postingDate: j.postingDate ?? null,
      sourceDocType: j.sourceDocType ?? null,
      sourceDocId: j.sourceDocId ?? null,
      totalDebit: j.totalDebit,
    },
  };
}

/** True if a journal for this source document already exists (idempotency guard). */
async function alreadyPosted(
  pool: Pool, ctx: RequestContext, sourceDocType: string, sourceDocId: number,
): Promise<boolean> {
  return runRead(pool, ctx, async (c) => {
    const res = await c.query(
      `SELECT 1 FROM fin.gl_entry
        WHERE company_id = $1 AND source_doc_type = $2 AND source_doc_id = $3
        LIMIT 1`,
      [ctx.companyId, sourceDocType, sourceDocId]);
    return (res.rowCount ?? 0) > 0;
  });
}

/** Resolve gl_id for each required gl_code; throws if any is missing (seed 024
 *  guarantees they exist, so absence is an operational error worth dead-lettering). */
async function resolveAccounts(
  pool: Pool, ctx: RequestContext, codes: string[],
): Promise<Map<string, number>> {
  const found = await runRead(pool, ctx, async (c) => {
    const res = await c.query(
      `SELECT gl_code, gl_id FROM mdm.gl_account
        WHERE company_id = $1 AND gl_code = ANY($2::text[])`,
      [ctx.companyId, codes]);
    return new Map<string, number>(res.rows.map((r) => [r.gl_code as string, Number(r.gl_id)]));
  });
  const missing = codes.filter((code) => !found.has(code));
  if (missing.length > 0) {
    throw new Error(
      `GL auto-posting: chart-of-accounts code(s) ${missing.join(', ')} not found for company ${ctx.companyId} `
      + '(run migration 024_gl_seed_accounts.sql)');
  }
  return found;
}

/** The company's first business unit — the journal-numbering scope (ctx.buId). */
async function resolveBuId(pool: Pool, ctx: RequestContext): Promise<number | null> {
  return runRead(pool, ctx, async (c) => {
    const res = await c.query(
      `SELECT bu_id FROM mdm.business_unit WHERE company_id = $1 ORDER BY bu_id LIMIT 1`,
      [ctx.companyId]);
    return res.rowCount ? Number(res.rows[0].bu_id) : null;
  });
}

/**
 * 'invoice.posted' (fin.invoice). Recognise the AR billing:
 *   Dr  1200 Accounts Receivable   total_amount
 *   Cr  4000 Project Revenue        taxable_amount   (project_id on this line)
 *   Cr  2110 GST Output Payable     tax              (omitted when tax = 0)
 * aggregateId is the invoice_id PK (BillingService emits aggregateId = id).
 */
export function invoicePostedGlHandler(pool: Pool): OutboxHandler {
  return async (e: OutboxRecord): Promise<void> => {
    if (e.aggregateId == null) return;
    const invoiceId = e.aggregateId;
    const ctx0 = systemContext(e, null);
    if (await alreadyPosted(pool, ctx0, DOC_INVOICE, invoiceId)) return;

    const inv = await runRead(pool, ctx0, async (c) => {
      const res = await c.query(
        `SELECT invoice_no, project_id, invoice_date, taxable_amount, tax_amount, total_amount
           FROM fin.invoice WHERE invoice_id = $1 AND company_id = $2`,
        [invoiceId, ctx0.companyId]);
      return res.rowCount ? res.rows[0] : null;
    });
    if (!inv) return; // invoice no longer exists / not visible; nothing to post

    const acct = await resolveAccounts(pool, ctx0, ['1200', '4000', '2110']);
    const projectId = inv.project_id == null ? undefined : Number(inv.project_id);
    const total = round4(Number(inv.total_amount));
    const taxable = round4(Number(inv.taxable_amount));
    const tax = round4(total - taxable);

    const lines: JournalInput['lines'] = [
      { glId: acct.get('1200')!, debit: total, credit: 0 },
      { glId: acct.get('4000')!, debit: 0, credit: taxable, projectId },
    ];
    // Only book GST output when there is tax — a zero-value line would be rejected.
    if (tax > 0) lines.push({ glId: acct.get('2110')!, debit: 0, credit: tax });

    const j: JournalInput = {
      postingDate: inv.invoice_date ?? undefined,
      narration: `AR invoice ${inv.invoice_no} posted`,
      sourceDocType: DOC_INVOICE,
      sourceDocId: invoiceId,
      totalDebit: total,
      lines,
    };
    const ctx = systemContext(e, await resolveBuId(pool, ctx0));
    await new GlRepository(pool).postJournal(ctx, j, postedEvent(ctx, j));
  };
}

/**
 * 'payment.received' (fin.payment_receipt). Settle the receivable with cash:
 *   Dr  1000 Bank                  amount
 *   Cr  1200 Accounts Receivable   amount
 * aggregateId is the receipt_id PK.
 */
export function paymentReceivedGlHandler(pool: Pool): OutboxHandler {
  return async (e: OutboxRecord): Promise<void> => {
    if (e.aggregateId == null) return;
    const receiptId = e.aggregateId;
    const ctx0 = systemContext(e, null);
    if (await alreadyPosted(pool, ctx0, DOC_RECEIPT, receiptId)) return;

    const rec = await runRead(pool, ctx0, async (c) => {
      const res = await c.query(
        `SELECT receipt_no, receipt_date, amount
           FROM fin.payment_receipt WHERE receipt_id = $1 AND company_id = $2`,
        [receiptId, ctx0.companyId]);
      return res.rowCount ? res.rows[0] : null;
    });
    if (!rec) return;

    const acct = await resolveAccounts(pool, ctx0, ['1000', '1200']);
    const amount = round4(Number(rec.amount));

    const j: JournalInput = {
      postingDate: rec.receipt_date ?? undefined,
      narration: `Customer receipt ${rec.receipt_no} received`,
      sourceDocType: DOC_RECEIPT,
      sourceDocId: receiptId,
      totalDebit: amount,
      lines: [
        { glId: acct.get('1000')!, debit: amount, credit: 0 },
        { glId: acct.get('1200')!, debit: 0, credit: amount },
      ],
    };
    const ctx = systemContext(e, await resolveBuId(pool, ctx0));
    await new GlRepository(pool).postJournal(ctx, j, postedEvent(ctx, j));
  };
}

/**
 * 'vendor_invoice.approved' (fin.vendor_invoice). Accrue the project cost / AP:
 *   Dr  5000 Project Cost (COGS)   total_amount
 *   Cr  2100 Accounts Payable      total_amount
 * aggregateId is the vendor_invoice_id PK (PayablesService emits aggregateId = id).
 */
export function vendorInvoiceApprovedGlHandler(pool: Pool): OutboxHandler {
  return async (e: OutboxRecord): Promise<void> => {
    if (e.aggregateId == null) return;
    const vendorInvoiceId = e.aggregateId;
    const ctx0 = systemContext(e, null);
    if (await alreadyPosted(pool, ctx0, DOC_VENDOR_INVOICE, vendorInvoiceId)) return;

    const vinv = await runRead(pool, ctx0, async (c) => {
      const res = await c.query(
        `SELECT vinv_no, invoice_date, total_amount
           FROM fin.vendor_invoice WHERE vendor_invoice_id = $1 AND company_id = $2`,
        [vendorInvoiceId, ctx0.companyId]);
      return res.rowCount ? res.rows[0] : null;
    });
    if (!vinv) return;

    const acct = await resolveAccounts(pool, ctx0, ['5000', '2100']);
    const amount = round4(Number(vinv.total_amount));

    const j: JournalInput = {
      postingDate: vinv.invoice_date ?? undefined,
      narration: `Vendor invoice ${vinv.vinv_no} approved`,
      sourceDocType: DOC_VENDOR_INVOICE,
      sourceDocId: vendorInvoiceId,
      totalDebit: amount,
      lines: [
        { glId: acct.get('5000')!, debit: amount, credit: 0 },
        { glId: acct.get('2100')!, debit: 0, credit: amount },
      ],
    };
    const ctx = systemContext(e, await resolveBuId(pool, ctx0));
    await new GlRepository(pool).postJournal(ctx, j, postedEvent(ctx, j));
  };
}
