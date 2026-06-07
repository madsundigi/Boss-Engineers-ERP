import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  VendorInvoice, VendorInvoiceLine, VendorPayment, VendorInvoiceListResult, ListResult,
} from './payables.types';
import { ListQueryDto, PaymentListQueryDto } from './payables.dto';
import { PAYMENT_DOC_TYPE, VendorInvoiceStatus } from './payables.constants';

// ---------------------------------------------------------------------------
// column lists + row mappers
// ---------------------------------------------------------------------------

// row_version, is_deleted, created_*/updated_* are added to the base table by
// migration 021 (db/05 ships fin.vendor_invoice WITHOUT them).
const INV_COLS = `vendor_invoice_id, company_id, bu_id, vinv_no, vendor_id, po_id, grn_id,
  invoice_date, total_amount, status, created_at, created_by, updated_at, row_version`;

type InvHeader = Omit<VendorInvoice, 'lines'>;

function mapInvoice(r: QueryResultRow): InvHeader {
  return {
    vendorInvoiceId: Number(r.vendor_invoice_id),
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    vinvNo: r.vinv_no,
    vendorId: Number(r.vendor_id),
    poId: r.po_id == null ? null : Number(r.po_id),
    grnId: r.grn_id == null ? null : Number(r.grn_id),
    invoiceDate: r.invoice_date,
    totalAmount: Number(r.total_amount),
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapLine(r: QueryResultRow): VendorInvoiceLine {
  return {
    vinvLineId: Number(r.vinv_line_id),
    itemId: r.item_id == null ? null : Number(r.item_id),
    qty: r.qty == null ? null : Number(r.qty),
    unitRate: r.unit_rate == null ? null : Number(r.unit_rate),
    amount: Number(r.amount),
  };
}

const PAY_COLS = `vpay_id, company_id, bu_id, vpay_no, vendor_id, vendor_invoice_id, pay_date, amount`;

function mapPayment(r: QueryResultRow): VendorPayment {
  return {
    vpayId: Number(r.vpay_id),
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    vpayNo: r.vpay_no,
    vendorId: Number(r.vendor_id),
    vendorInvoiceId: r.vendor_invoice_id == null ? null : Number(r.vendor_invoice_id),
    payDate: r.pay_date,
    amount: Number(r.amount),
  };
}

// ---- input shapes (service -> repository) ---------------------------------

export interface VendorInvoiceHeaderInput {
  vinvNo: string;
  vendorId: number;
  poId?: number;
  grnId?: number;
  invoiceDate?: string;
}
export interface VendorInvoiceLineInput {
  itemId?: number;
  qty?: number;
  unitRate?: number;
  amount: number;
}
/** Header fields that may be patched on an update (vinv_no / po_id / grn_id / date). */
export interface VendorInvoiceHeaderPatch {
  vinvNo?: string;
  poId?: number;
  grnId?: number;
  invoiceDate?: string;
}
export interface VendorPaymentInput {
  vendorId: number;
  vendorInvoiceId: number;
  amount: number;
  payDate?: string;
}

export class PayablesRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchLines(q: Queryable, id: number): Promise<VendorInvoiceLine[]> {
    const res = await q.query(
      `SELECT vinv_line_id, item_id, qty, unit_rate, amount
         FROM fin.vendor_invoice_line WHERE vendor_invoice_id = $1 ORDER BY vinv_line_id`, [id]);
    return res.rows.map(mapLine);
  }
  private async insertLines(q: Queryable, id: number, lines: VendorInvoiceLineInput[]): Promise<void> {
    for (const l of lines) {
      await q.query(
        `INSERT INTO fin.vendor_invoice_line (vendor_invoice_id, item_id, qty, unit_rate, amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, l.itemId ?? null, l.qty ?? null, l.unitRate ?? null, l.amount]);
    }
  }

  /** Insert a vendor invoice header (PENDING) + lines in one transaction. */
  async create(
    ctx: RequestContext, h: VendorInvoiceHeaderInput, lines: VendorInvoiceLineInput[], totalAmount: number,
  ): Promise<VendorInvoice> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO fin.vendor_invoice
           (company_id, bu_id, vinv_no, vendor_id, po_id, grn_id, invoice_date,
            total_amount, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::date, current_date), $8, 'PENDING', $9)
         RETURNING ${INV_COLS}`,
        [
          ctx.companyId, ctx.buId, h.vinvNo, h.vendorId, h.poId ?? null, h.grnId ?? null,
          h.invoiceDate ?? null, totalAmount, ctx.userId,
        ]);
      const header = mapInvoice(res.rows[0]);
      await this.insertLines(c, header.vendorInvoiceId, lines);
      return { ...header, lines: await this.fetchLines(c, header.vendorInvoiceId) };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<VendorInvoice | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${INV_COLS} FROM fin.vendor_invoice
          WHERE vendor_invoice_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapInvoice(res.rows[0]), lines: await this.fetchLines(c, id) };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<VendorInvoiceListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.vendorId) { params.push(q.vendorId); where.push(`vendor_id = $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM fin.vendor_invoice WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${INV_COLS} FROM fin.vendor_invoice WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapInvoice), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked header update + full line replacement. Null on version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number,
    fields: VendorInvoiceHeaderPatch, lines: VendorInvoiceLineInput[] | undefined, totalAmount: number,
  ): Promise<VendorInvoice | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.vinvNo !== undefined) add('vinv_no', fields.vinvNo);
    if (fields.poId !== undefined) add('po_id', fields.poId);
    if (fields.grnId !== undefined) add('grn_id', fields.grnId);
    if (fields.invoiceDate !== undefined) add('invoice_date', fields.invoiceDate);
    if (lines) add('total_amount', totalAmount);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE fin.vendor_invoice
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE vendor_invoice_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${INV_COLS}`, params);
      if (!res.rowCount) return null;
      const header = mapInvoice(res.rows[0]);
      if (lines) {
        await c.query(`DELETE FROM fin.vendor_invoice_line WHERE vendor_invoice_id = $1`, [id]);
        await this.insertLines(c, id, lines);
      }
      return { ...header, lines: await this.fetchLines(c, id) };
    });
  }

  /**
   * Optimistic-locked status change with an optional outbox event emitted
   * atomically with the state change (transactional outbox). Null on a
   * row-version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: VendorInvoiceStatus,
    event?: OutboxEventInput,
  ): Promise<VendorInvoice | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE fin.vendor_invoice
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE vendor_invoice_id = $3 AND company_id = $4 AND row_version = $5 AND NOT is_deleted
        RETURNING ${INV_COLS}`,
        [status, ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;
      if (event) await emitOutbox(c, event);
      return { ...mapInvoice(res.rows[0]), lines: await this.fetchLines(c, id) };
    });
  }

  /**
   * The PO's total_amount for the 3-way-match check, scoped to the company (RLS).
   * Returns null if the PO does not exist / is not visible, so the service can
   * treat a dangling reference as "no PO total to verify" rather than erroring.
   */
  async poTotal(ctx: RequestContext, poId: number): Promise<number | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ total_amount: string }>(
        `SELECT total_amount FROM scm.purchase_order
          WHERE po_id = $1 AND company_id = $2 AND NOT is_deleted`, [poId, ctx.companyId]);
      return res.rowCount ? Number(res.rows[0].total_amount) : null;
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE fin.vendor_invoice
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE vendor_invoice_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  // =========================================================================
  // Vendor payments
  // =========================================================================

  /** Σ of all payments already recorded against an invoice (RLS-scoped read). */
  async paidTotal(ctx: RequestContext, vendorInvoiceId: number): Promise<number> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ paid: string }>(
        `SELECT COALESCE(SUM(amount),0)::text paid FROM fin.vendor_payment
          WHERE vendor_invoice_id = $1 AND company_id = $2`, [vendorInvoiceId, ctx.companyId]);
      return Number(res.rows[0].paid);
    });
  }

  /**
   * Record a payment (allocating the 'VPAY' number) and, when the cumulative
   * paid amount reaches the invoice total, flip the invoice to PAID — all in ONE
   * transaction so the payment and the status change commit together.
   * `markPaid` is decided by the service (Σ payments >= total). Returns the payment.
   */
  async createPayment(
    ctx: RequestContext, p: VendorPaymentInput, markPaid: boolean,
  ): Promise<VendorPayment> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO fin.vendor_payment
           (company_id, bu_id, vpay_no, vendor_id, vendor_invoice_id, pay_date, amount)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${PAYMENT_DOC_TYPE}'),
                 $3,$4, COALESCE($5::date, current_date), $6)
         RETURNING ${PAY_COLS}`,
        [ctx.companyId, ctx.buId, p.vendorId, p.vendorInvoiceId, p.payDate ?? null, p.amount]);
      if (markPaid) {
        await c.query(
          `UPDATE fin.vendor_invoice
              SET status = 'PAID', updated_by = $1, updated_at = now(), row_version = row_version + 1
            WHERE vendor_invoice_id = $2 AND company_id = $3 AND status = 'APPROVED' AND NOT is_deleted`,
          [ctx.userId, p.vendorInvoiceId, ctx.companyId]);
      }
      return mapPayment(res.rows[0]);
    });
  }

  async listPayments(ctx: RequestContext, q: PaymentListQueryDto): Promise<ListResult<VendorPayment>> {
    const where: string[] = ['company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.vendorId) { params.push(q.vendorId); where.push(`vendor_id = $${params.length}`); }
    if (q.vendorInvoiceId) { params.push(q.vendorInvoiceId); where.push(`vendor_invoice_id = $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM fin.vendor_payment WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${PAY_COLS} FROM fin.vendor_payment WHERE ${w}
          ORDER BY vpay_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapPayment), total, page: q.page, pageSize: q.pageSize };
    });
  }
}
