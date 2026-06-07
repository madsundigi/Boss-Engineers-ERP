import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  TaxCode, TaxTransaction, TaxTransactionListResult, GstSplit, GstSummary, InvoiceForTax,
} from './tax.types';
import { TaxCodeQueryDto, TxnQueryDto, SummaryQueryDto } from './tax.dto';
import { TAX_DOC_TYPE_INVOICE } from './tax.constants';

// mdm.tax_code is a GLOBAL master (no company_id) — never filter it by company.
const TC = `tax_code_id, code, cgst_rate, sgst_rate, igst_rate, is_active`;
// fin.tax_transaction columns (per-company, append-only).
const TT = `tax_txn_id, company_id, doc_type, doc_id, txn_date, taxable_amount, cgst, sgst, igst`;
// The fin.invoice columns this module reads / stamps (Billing owns the rest).
const INV = `invoice_id, company_id, invoice_no, invoice_date, taxable_amount,
  tax_amount, total_amount, status, irn, ack_no, eway_bill_no`;

function mapTaxCode(r: QueryResultRow): TaxCode {
  return {
    taxCodeId: Number(r.tax_code_id),
    code: r.code,
    cgstRate: Number(r.cgst_rate),
    sgstRate: Number(r.sgst_rate),
    igstRate: Number(r.igst_rate),
    isActive: r.is_active,
  };
}
function mapTxn(r: QueryResultRow): TaxTransaction {
  return {
    taxTxnId: Number(r.tax_txn_id),
    companyId: Number(r.company_id),
    docType: r.doc_type,
    docId: Number(r.doc_id),
    txnDate: r.txn_date,
    taxableAmount: Number(r.taxable_amount),
    cgst: Number(r.cgst),
    sgst: Number(r.sgst),
    igst: Number(r.igst),
  };
}
function mapInvoice(r: QueryResultRow): InvoiceForTax {
  return {
    invoiceId: Number(r.invoice_id),
    companyId: Number(r.company_id),
    invoiceNo: r.invoice_no,
    invoiceDate: r.invoice_date,
    taxableAmount: Number(r.taxable_amount),
    taxAmount: Number(r.tax_amount),
    totalAmount: Number(r.total_amount),
    status: r.status,
    irn: r.irn,
    ackNo: r.ack_no,
    ewayBillNo: r.eway_bill_no,
  };
}

export interface TaxCodeInput {
  code: string;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  isActive: boolean;
}

export class TaxRepository {
  constructor(private readonly pool: Pool) {}

  // =====================================================================
  // Tax-code master (mdm.tax_code) — GLOBAL, no company scoping, no RLS.
  // =====================================================================
  async createTaxCode(ctx: RequestContext, tc: TaxCodeInput): Promise<TaxCode> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO mdm.tax_code (code, cgst_rate, sgst_rate, igst_rate, is_active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${TC}`,
        [tc.code, tc.cgstRate, tc.sgstRate, tc.igstRate, tc.isActive]);
      return mapTaxCode(res.rows[0]);
    });
  }

  async findTaxCodeById(ctx: RequestContext, id: number): Promise<TaxCode | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(`SELECT ${TC} FROM mdm.tax_code WHERE tax_code_id = $1`, [id]);
      return res.rowCount ? mapTaxCode(res.rows[0]) : null;
    });
  }

  async findTaxCodeByCode(ctx: RequestContext, code: string): Promise<TaxCode | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(`SELECT ${TC} FROM mdm.tax_code WHERE code = $1`, [code]);
      return res.rowCount ? mapTaxCode(res.rows[0]) : null;
    });
  }

  async listTaxCodes(ctx: RequestContext, q: TaxCodeQueryDto): Promise<TaxCode[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.isActive !== undefined) { params.push(q.isActive); where.push(`is_active = $${params.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(`SELECT ${TC} FROM mdm.tax_code ${w} ORDER BY code`, params);
      return res.rows.map(mapTaxCode);
    });
  }

  /** Flip is_active on a tax code. Returns the updated row, or null if not found. */
  async setActive(ctx: RequestContext, id: number, isActive: boolean): Promise<TaxCode | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE mdm.tax_code SET is_active = $1 WHERE tax_code_id = $2 RETURNING ${TC}`,
        [isActive, id]);
      return res.rowCount ? mapTaxCode(res.rows[0]) : null;
    });
  }

  // =====================================================================
  // fin.invoice — READ + STAMP ONLY (the AR Billing module owns its lifecycle).
  // =====================================================================
  async findInvoice(ctx: RequestContext, invoiceId: number): Promise<InvoiceForTax | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${INV} FROM fin.invoice
          WHERE invoice_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [invoiceId, ctx.companyId]);
      return res.rowCount ? mapInvoice(res.rows[0]) : null;
    });
  }

  /**
   * E-invoice in ONE transaction: stamp irn/ack_no on fin.invoice, append the
   * fin.tax_transaction GST-ledger row, and record the einvoice.generated outbox
   * event — all atomic. The invoice UPDATE touches only irn/ack_no (company_id
   * unchanged), so Billing's per-company RLS policy on fin.invoice is satisfied;
   * the ledger insert sets company_id = ctx.companyId to pass our own RLS policy.
   * Returns null if the invoice row could not be re-stamped (lost to a race).
   */
  async applyEInvoice(
    ctx: RequestContext, inv: InvoiceForTax, irn: string, ackNo: string, split: GstSplit,
    event: OutboxEventInput,
  ): Promise<TaxTransaction | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const upd = await c.query(
        `UPDATE fin.invoice SET irn = $1, ack_no = $2, updated_at = now()
          WHERE invoice_id = $3 AND company_id = $4 AND irn IS NULL AND NOT is_deleted`,
        [irn, ackNo, inv.invoiceId, ctx.companyId]);
      if (!upd.rowCount) return null; // concurrent stamp / vanished — abort the txn
      const ins = await c.query(
        `INSERT INTO fin.tax_transaction
           (company_id, doc_type, doc_id, txn_date, taxable_amount, cgst, sgst, igst)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${TT}`,
        [ctx.companyId, TAX_DOC_TYPE_INVOICE, inv.invoiceId, inv.invoiceDate,
         inv.taxableAmount, split.cgst, split.sgst, split.igst]);
      // Atomic with the stamp + ledger row: record the domain event.
      await emitOutbox(c, event);
      return mapTxn(ins.rows[0]);
    });
  }

  /**
   * Stamp the e-way bill number on fin.invoice (only if none yet) and record the
   * eway_bill.generated outbox event, atomically. Returns false if the row could
   * not be stamped (already had one / vanished). company_id is unchanged so
   * Billing's RLS company policy is satisfied.
   */
  async applyEwayBill(
    ctx: RequestContext, invoiceId: number, ewayBillNo: string, event: OutboxEventInput,
  ): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const upd = await c.query(
        `UPDATE fin.invoice SET eway_bill_no = $1, updated_at = now()
          WHERE invoice_id = $2 AND company_id = $3 AND eway_bill_no IS NULL AND NOT is_deleted`,
        [ewayBillNo, invoiceId, ctx.companyId]);
      if (!upd.rowCount) return false;
      await emitOutbox(c, event);
      return true;
    });
  }

  // =====================================================================
  // GST ledger reads (fin.tax_transaction) — per-company, RLS-scoped.
  // =====================================================================
  async listTransactions(ctx: RequestContext, q: TxnQueryDto): Promise<TaxTransactionListResult> {
    const where: string[] = ['company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.docType) { params.push(q.docType); where.push(`doc_type = $${params.length}`); }
    if (q.fromDate) { params.push(q.fromDate); where.push(`txn_date >= $${params.length}`); }
    if (q.toDate) { params.push(q.toDate); where.push(`txn_date <= $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM fin.tax_transaction WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${TT} FROM fin.tax_transaction WHERE ${w}
          ORDER BY txn_date DESC, tax_txn_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapTxn), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** GSTR-style liability totals: Σ taxable, Σ cgst, Σ sgst, Σ igst over a period. */
  async summarise(ctx: RequestContext, q: SummaryQueryDto): Promise<GstSummary> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT COALESCE(sum(taxable_amount), 0)::text AS taxable_amount,
                COALESCE(sum(cgst), 0)::text          AS cgst,
                COALESCE(sum(sgst), 0)::text          AS sgst,
                COALESCE(sum(igst), 0)::text          AS igst,
                count(*)::text                        AS c
           FROM fin.tax_transaction
          WHERE company_id = $1 AND txn_date >= $2 AND txn_date <= $3`,
        [ctx.companyId, q.fromDate, q.toDate]);
      const r = res.rows[0];
      const cgst = Number(r.cgst);
      const sgst = Number(r.sgst);
      const igst = Number(r.igst);
      return {
        fromDate: q.fromDate,
        toDate: q.toDate,
        taxableAmount: Number(r.taxable_amount),
        cgst,
        sgst,
        igst,
        totalTax: cgst + sgst + igst,
        count: Number(r.c),
      };
    });
  }
}
