import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  Invoice, InvoiceLine, Receipt, Allocation, Advance, Retention, RevenueEntry,
  InvoiceListResult, ListResult,
} from './billing.types';
import {
  ListQueryDto, ReceiptQueryDto, AdvanceQueryDto, RetentionQueryDto,
} from './billing.dto';
import {
  INVOICE_DOC_TYPE, RECEIPT_DOC_TYPE, InvoiceStatus, RetentionStatus, RevenueMethod,
} from './billing.constants';

/** Header columns of fin.invoice (bu_id added in migration 020). irn/ack_no are
 *  owned by the Tax module and are deliberately not selected. */
const H = `invoice_id, invoice_no, company_id, bu_id, project_id, customer_id,
  milestone_id, invoice_date, currency_id, taxable_amount, tax_amount, total_amount,
  status, created_at, created_by, updated_at, row_version`;
const RC = `receipt_id, receipt_no, company_id, customer_id, receipt_date, amount, mode, reference`;
const AD = `advance_id, project_id, customer_id, advance_date, amount, adjusted_amount`;
const RT = `retention_id, project_id, invoice_id, retained_amount, release_due_date, released_amount, status`;
const RV = `rev_id, project_id, milestone_id, recognition_date, method, amount`;

type InvoiceHeader = Omit<Invoice, 'lines'>;

function mapHeader(r: QueryResultRow): InvoiceHeader {
  return {
    invoiceId: Number(r.invoice_id),
    invoiceNo: r.invoice_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    customerId: Number(r.customer_id),
    milestoneId: r.milestone_id == null ? null : Number(r.milestone_id),
    invoiceDate: r.invoice_date,
    currencyId: Number(r.currency_id),
    taxableAmount: Number(r.taxable_amount),
    taxAmount: Number(r.tax_amount),
    totalAmount: Number(r.total_amount),
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapLine(r: QueryResultRow): InvoiceLine {
  return {
    invoiceLineId: Number(r.invoice_line_id),
    itemId: r.item_id == null ? null : Number(r.item_id),
    description: r.description,
    qty: Number(r.qty),
    unitRate: Number(r.unit_rate),
    taxableAmount: Number(r.taxable_amount),
    taxCodeId: r.tax_code_id == null ? null : Number(r.tax_code_id),
    taxAmount: Number(r.tax_amount),
  };
}
function mapReceipt(r: QueryResultRow): Omit<Receipt, 'allocations'> {
  return {
    receiptId: Number(r.receipt_id),
    receiptNo: r.receipt_no,
    companyId: Number(r.company_id),
    customerId: Number(r.customer_id),
    receiptDate: r.receipt_date,
    amount: Number(r.amount),
    mode: r.mode,
    reference: r.reference,
  };
}
function mapAllocation(r: QueryResultRow): Allocation {
  return {
    allocationId: Number(r.allocation_id),
    receiptId: Number(r.receipt_id),
    invoiceId: Number(r.invoice_id),
    allocatedAmount: Number(r.allocated_amount),
  };
}
function mapAdvance(r: QueryResultRow): Advance {
  return {
    advanceId: Number(r.advance_id),
    projectId: Number(r.project_id),
    customerId: Number(r.customer_id),
    advanceDate: r.advance_date,
    amount: Number(r.amount),
    adjustedAmount: Number(r.adjusted_amount),
  };
}
function mapRetention(r: QueryResultRow): Retention {
  return {
    retentionId: Number(r.retention_id),
    projectId: Number(r.project_id),
    invoiceId: r.invoice_id == null ? null : Number(r.invoice_id),
    retainedAmount: Number(r.retained_amount),
    releaseDueDate: r.release_due_date,
    releasedAmount: Number(r.released_amount),
    status: r.status,
  };
}
function mapRevenue(r: QueryResultRow): RevenueEntry {
  return {
    revId: Number(r.rev_id),
    projectId: Number(r.project_id),
    milestoneId: r.milestone_id == null ? null : Number(r.milestone_id),
    recognitionDate: r.recognition_date,
    method: r.method,
    amount: Number(r.amount),
  };
}

/** A fully-computed invoice line ready to persist (the service builds these). */
export interface ComputedLine {
  itemId?: number;
  description: string;
  qty: number;
  unitRate: number;
  taxableAmount: number;
  taxCodeId?: number;
  taxAmount: number;
}

/** Header fields the service supplies for create / update (amounts computed). */
export interface InvoiceHeaderInput {
  projectId?: number;
  customerId: number;
  milestoneId?: number;
  currencyId: number;
  invoiceDate?: string;
  taxableAmount: number;
  taxAmount: number;
  totalAmount: number;
}

/** A receipt the service has validated, ready to persist with its allocations. */
export interface ReceiptInput {
  customerId: number;
  amount: number;
  receiptDate?: string;
  mode?: string;
  reference?: string;
  allocations: { invoiceId: number; allocatedAmount: number }[];
}

export class BillingRepository {
  constructor(private readonly pool: Pool) {}

  // ---------------------------------------------------------------------
  // Tax-code rates + currency resolution (read helpers used by the service).
  // ---------------------------------------------------------------------
  /** Resolve cgst+sgst+igst rate sums for the given tax_code ids (percent). */
  async fetchTaxRates(ctx: RequestContext, taxCodeIds: number[]): Promise<Map<number, number>> {
    if (taxCodeIds.length === 0) return new Map();
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT tax_code_id, (cgst_rate + sgst_rate + igst_rate) AS rate
           FROM mdm.tax_code WHERE tax_code_id = ANY($1::bigint[])`,
        [taxCodeIds]);
      return new Map(res.rows.map((r) => [Number(r.tax_code_id), Number(r.rate)]));
    });
  }

  /** Resolve the company's INR currency id (fallback when none supplied). */
  async resolveInrCurrencyId(ctx: RequestContext): Promise<number | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(`SELECT currency_id FROM mdm.currency WHERE iso_code = 'INR'`);
      return res.rowCount ? Number(res.rows[0].currency_id) : null;
    });
  }

  // ---------------------------------------------------------------------
  // Invoice header + lines.
  // ---------------------------------------------------------------------
  private async fetchLines(q: Queryable, invoiceId: number): Promise<InvoiceLine[]> {
    const res = await q.query(
      `SELECT invoice_line_id, item_id, description, qty, unit_rate,
              taxable_amount, tax_code_id, tax_amount
         FROM fin.invoice_line WHERE invoice_id = $1 ORDER BY invoice_line_id`,
      [invoiceId]);
    return res.rows.map(mapLine);
  }
  private async insertLines(q: Queryable, invoiceId: number, lines: ComputedLine[]): Promise<void> {
    for (const l of lines) {
      await q.query(
        `INSERT INTO fin.invoice_line
           (invoice_id, item_id, description, qty, unit_rate, taxable_amount, tax_code_id, tax_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [invoiceId, l.itemId ?? null, l.description, l.qty, l.unitRate,
          l.taxableAmount, l.taxCodeId ?? null, l.taxAmount]);
    }
  }

  /** Insert an invoice (DRAFT) + its lines, allocating the invoice number in the
   *  same transaction. company_id = ctx.companyId so the row passes the RLS WITH CHECK. */
  async create(ctx: RequestContext, h: InvoiceHeaderInput, lines: ComputedLine[]): Promise<Invoice> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO fin.invoice
           (company_id, bu_id, invoice_no, project_id, customer_id, milestone_id,
            invoice_date, currency_id, taxable_amount, tax_amount, total_amount, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${INVOICE_DOC_TYPE}'),
                 $3,$4,$5, COALESCE($6::date, current_date), $7,$8,$9,$10, 'DRAFT', $11)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.projectId ?? null, h.customerId, h.milestoneId ?? null,
          h.invoiceDate ?? null, h.currencyId, h.taxableAmount, h.taxAmount, h.totalAmount, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      await this.insertLines(c, header.invoiceId, lines);
      return { ...header, lines: await this.fetchLines(c, header.invoiceId) };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Invoice | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM fin.invoice
          WHERE invoice_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), lines: await this.fetchLines(c, id) };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<InvoiceListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.customerId) { params.push(q.customerId); where.push(`customer_id = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`invoice_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM fin.invoice WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM fin.invoice WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked header update + full line replacement (DRAFT only — the
   *  service guards status). Returns null on a row-version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number,
    h: InvoiceHeaderInput, lines: ComputedLine[],
  ): Promise<Invoice | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE fin.invoice
            SET project_id = $1, milestone_id = $2, currency_id = $3,
                invoice_date = COALESCE($4::date, invoice_date),
                taxable_amount = $5, tax_amount = $6, total_amount = $7,
                updated_by = $8, updated_at = now(), row_version = row_version + 1
          WHERE invoice_id = $9 AND company_id = $10 AND row_version = $11 AND NOT is_deleted
        RETURNING ${H}`,
        [
          h.projectId ?? null, h.milestoneId ?? null, h.currencyId, h.invoiceDate ?? null,
          h.taxableAmount, h.taxAmount, h.totalAmount, ctx.userId,
          id, ctx.companyId, expectedVersion,
        ]);
      if (!res.rowCount) return null;
      const header = mapHeader(res.rows[0]);
      await c.query(`DELETE FROM fin.invoice_line WHERE invoice_id = $1`, [id]);
      await this.insertLines(c, id, lines);
      return { ...header, lines: await this.fetchLines(c, id) };
    });
  }

  /**
   * Lifecycle status change under optimistic lock, with an optional outbox event
   * emitted atomically with the state change. Returns null on a version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: InvoiceStatus,
    event?: OutboxEventInput,
  ): Promise<Invoice | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE fin.invoice
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE invoice_id = $3 AND company_id = $4 AND row_version = $5 AND NOT is_deleted
        RETURNING ${H}`,
        [status, ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;
      if (event) await emitOutbox(c, event);
      return { ...mapHeader(res.rows[0]), lines: await this.fetchLines(c, id) };
    });
  }

  /** Soft delete (DRAFT only — service guards). Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE fin.invoice
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE invoice_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  // ---------------------------------------------------------------------
  // Receipts & allocation. Allocating updates each invoice's paid status from
  // the live SUM(payment_allocation) vs total_amount — all in one transaction.
  // ---------------------------------------------------------------------
  /**
   * Resolve the outstanding (unallocated) amount + current status for a set of
   * invoices, scoped to the company. Used to validate an incoming allocation
   * against each invoice's remaining balance.
   */
  async fetchInvoiceOutstanding(
    ctx: RequestContext, invoiceIds: number[],
  ): Promise<Map<number, { status: InvoiceStatus; total: number; allocated: number }>> {
    if (invoiceIds.length === 0) return new Map();
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT i.invoice_id, i.status, i.total_amount,
                COALESCE((SELECT sum(a.allocated_amount) FROM fin.payment_allocation a
                           WHERE a.invoice_id = i.invoice_id), 0) AS allocated
           FROM fin.invoice i
          WHERE i.company_id = $1 AND i.invoice_id = ANY($2::bigint[]) AND NOT i.is_deleted`,
        [ctx.companyId, invoiceIds]);
      return new Map(res.rows.map((r) => [
        Number(r.invoice_id),
        { status: r.status as InvoiceStatus, total: Number(r.total_amount), allocated: Number(r.allocated) },
      ]));
    });
  }

  /** Insert a receipt + its allocations, refresh touched invoices' paid status,
   *  and emit the payment event — all atomically. */
  async createReceipt(ctx: RequestContext, r: ReceiptInput, event: OutboxEventInput): Promise<Receipt> {
    return runInContext(this.pool, ctx, async (c) => {
      const head = await c.query(
        `INSERT INTO fin.payment_receipt
           (company_id, receipt_no, customer_id, receipt_date, amount, mode, reference)
         VALUES ($1, mdm.next_document_no($1,$2,'${RECEIPT_DOC_TYPE}'),
                 $3, COALESCE($4::date, current_date), $5, $6, $7)
         RETURNING ${RC}`,
        [ctx.companyId, ctx.buId, r.customerId, r.receiptDate ?? null, r.amount, r.mode ?? null, r.reference ?? null]);
      const receipt = mapReceipt(head.rows[0]);

      const allocations: Allocation[] = [];
      for (const a of r.allocations) {
        const ar = await c.query(
          `INSERT INTO fin.payment_allocation (receipt_id, invoice_id, allocated_amount)
           VALUES ($1,$2,$3) RETURNING allocation_id, receipt_id, invoice_id, allocated_amount`,
          [receipt.receiptId, a.invoiceId, a.allocatedAmount]);
        allocations.push(mapAllocation(ar.rows[0]));
        // Refresh THIS invoice's paid status from the live allocation sum.
        await this.refreshInvoicePaidStatus(c, ctx, a.invoiceId);
      }
      await emitOutbox(c, event);
      return { ...receipt, allocations };
    });
  }

  /**
   * Recompute one invoice's status from SUM(payment_allocation) vs total_amount:
   *   fully covered -> PAID; partially -> PARTIALLY_PAID; nothing -> leave as-is.
   * Only nudges an allocatable invoice (POSTED/SENT/PARTIALLY_PAID); never touches
   * DRAFT/CANCELLED. Bumps row_version so the change is audited like any update.
   */
  private async refreshInvoicePaidStatus(c: Queryable, ctx: RequestContext, invoiceId: number): Promise<void> {
    await c.query(
      `UPDATE fin.invoice i
          SET status = CASE
                WHEN paid.total >= i.total_amount THEN 'PAID'
                WHEN paid.total > 0 THEN 'PARTIALLY_PAID'
                ELSE i.status
              END,
              updated_by = $2, updated_at = now(), row_version = row_version + 1
         FROM (SELECT COALESCE(sum(allocated_amount), 0) AS total
                 FROM fin.payment_allocation WHERE invoice_id = $1) paid
        WHERE i.invoice_id = $1 AND i.company_id = $3
          AND i.status IN ('POSTED','SENT','PARTIALLY_PAID') AND NOT i.is_deleted`,
      [invoiceId, ctx.userId, ctx.companyId]);
  }

  async findReceipt(ctx: RequestContext, id: number): Promise<Receipt | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${RC} FROM fin.payment_receipt WHERE receipt_id = $1 AND company_id = $2`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      const alloc = await c.query(
        `SELECT allocation_id, receipt_id, invoice_id, allocated_amount
           FROM fin.payment_allocation WHERE receipt_id = $1 ORDER BY allocation_id`, [id]);
      return { ...mapReceipt(res.rows[0]), allocations: alloc.rows.map(mapAllocation) };
    });
  }

  async listReceipts(ctx: RequestContext, q: ReceiptQueryDto): Promise<ListResult<Omit<Receipt, 'allocations'>>> {
    const where: string[] = ['company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.customerId) { params.push(q.customerId); where.push(`customer_id = $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM fin.payment_receipt WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${RC} FROM fin.payment_receipt WHERE ${w}
          ORDER BY receipt_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapReceipt), total, page: q.page, pageSize: q.pageSize };
    });
  }

  // ---------------------------------------------------------------------
  // Advances (fin.advance) — project-scoped, no company_id column.
  // ---------------------------------------------------------------------
  async createAdvance(
    ctx: RequestContext, a: { projectId: number; customerId: number; amount: number; advanceDate?: string },
  ): Promise<Advance> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO fin.advance (project_id, customer_id, advance_date, amount)
         VALUES ($1, $2, COALESCE($3::date, current_date), $4)
         RETURNING ${AD}`,
        [a.projectId, a.customerId, a.advanceDate ?? null, a.amount]);
      return mapAdvance(res.rows[0]);
    });
  }

  async findAdvance(ctx: RequestContext, id: number): Promise<Advance | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(`SELECT ${AD} FROM fin.advance WHERE advance_id = $1`, [id]);
      return res.rowCount ? mapAdvance(res.rows[0]) : null;
    });
  }

  async listAdvances(ctx: RequestContext, q: AdvanceQueryDto): Promise<Advance[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.customerId) { params.push(q.customerId); where.push(`customer_id = $${params.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(`SELECT ${AD} FROM fin.advance ${w} ORDER BY advance_id DESC`, params);
      return res.rows.map(mapAdvance);
    });
  }

  /**
   * Increase adjusted_amount by `delta`, but only while the running total stays
   * within `amount` (the WHERE guards the cap). Returns the updated row, or null
   * if the guard blocked it (over-adjustment) or the advance was not found.
   */
  async adjustAdvance(ctx: RequestContext, id: number, delta: number): Promise<Advance | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE fin.advance SET adjusted_amount = adjusted_amount + $1
          WHERE advance_id = $2 AND adjusted_amount + $1 <= amount
        RETURNING ${AD}`, [delta, id]);
      return res.rowCount ? mapAdvance(res.rows[0]) : null;
    });
  }

  // ---------------------------------------------------------------------
  // Retention (fin.retention) — project-scoped, no company_id column.
  // ---------------------------------------------------------------------
  async createRetention(
    ctx: RequestContext,
    r: { projectId: number; invoiceId?: number; retainedAmount: number; releaseDueDate?: string },
  ): Promise<Retention> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO fin.retention (project_id, invoice_id, retained_amount, release_due_date, status)
         VALUES ($1, $2, $3, $4::date, 'HELD')
         RETURNING ${RT}`,
        [r.projectId, r.invoiceId ?? null, r.retainedAmount, r.releaseDueDate ?? null]);
      return mapRetention(res.rows[0]);
    });
  }

  async findRetention(ctx: RequestContext, id: number): Promise<Retention | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(`SELECT ${RT} FROM fin.retention WHERE retention_id = $1`, [id]);
      return res.rowCount ? mapRetention(res.rows[0]) : null;
    });
  }

  async listRetentions(ctx: RequestContext, q: RetentionQueryDto): Promise<Retention[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(`SELECT ${RT} FROM fin.retention ${w} ORDER BY retention_id DESC`, params);
      return res.rows.map(mapRetention);
    });
  }

  /** Set released_amount + the resulting status atomically. The service has
   *  already validated the running total against retained_amount. */
  async releaseRetention(
    ctx: RequestContext, id: number, releasedAmount: number, status: RetentionStatus,
  ): Promise<Retention | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE fin.retention SET released_amount = $1, status = $2
          WHERE retention_id = $3
        RETURNING ${RT}`, [releasedAmount, status, id]);
      return res.rowCount ? mapRetention(res.rows[0]) : null;
    });
  }

  // ---------------------------------------------------------------------
  // Revenue recognition (fin.revenue_recognition) — append-only, project-scoped.
  // ---------------------------------------------------------------------
  async recognizeRevenue(
    ctx: RequestContext,
    r: { projectId: number; milestoneId?: number; recognitionDate?: string; method: RevenueMethod; amount: number },
  ): Promise<RevenueEntry> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO fin.revenue_recognition
           (project_id, milestone_id, recognition_date, method, amount)
         VALUES ($1, $2, COALESCE($3::date, current_date), $4, $5)
         RETURNING ${RV}`,
        [r.projectId, r.milestoneId ?? null, r.recognitionDate ?? null, r.method, r.amount]);
      return mapRevenue(res.rows[0]);
    });
  }

  async listRevenue(ctx: RequestContext, projectId: number): Promise<RevenueEntry[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${RV} FROM fin.revenue_recognition WHERE project_id = $1
          ORDER BY recognition_date DESC, rev_id DESC`, [projectId]);
      return res.rows.map(mapRevenue);
    });
  }
}
