import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  PurchaseRequisition, PrLine, PurchaseOrder, PoLine, GoodsReceipt, GrnLine,
} from './procurement.types';
import {
  PrListQueryDto, PoListQueryDto, GrnListQueryDto,
} from './procurement.dto';
import { DOC_TYPE, PrStatus, PoStatus, GrnStatus } from './procurement.constants';

// ---------------------------------------------------------------------------
// column lists + row mappers
// ---------------------------------------------------------------------------

const PR_COLS = `pr_id, pr_no, company_id, bu_id, project_id, wbs_id, required_date,
  status, created_by, created_at, row_version`;

function mapPr(r: QueryResultRow): Omit<PurchaseRequisition, 'lines'> {
  return {
    prId: Number(r.pr_id), prNo: r.pr_no, companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    wbsId: r.wbs_id == null ? null : Number(r.wbs_id),
    requiredDate: r.required_date, status: r.status,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at, rowVersion: Number(r.row_version),
  };
}
function mapPrLine(r: QueryResultRow): PrLine {
  return {
    prLineId: Number(r.pr_line_id), itemId: Number(r.item_id), qty: Number(r.qty),
    uomId: r.uom_id == null ? null : Number(r.uom_id), requiredDate: r.required_date,
  };
}

const PO_COLS = `po_id, po_no, company_id, bu_id, vendor_id, project_id, po_date,
  currency_id, total_amount, expected_date, status, created_by, created_at, row_version`;

function mapPo(r: QueryResultRow): Omit<PurchaseOrder, 'lines'> {
  return {
    poId: Number(r.po_id), poNo: r.po_no, companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id), vendorId: Number(r.vendor_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    poDate: r.po_date, currencyId: Number(r.currency_id),
    totalAmount: Number(r.total_amount), expectedDate: r.expected_date, status: r.status,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at, rowVersion: Number(r.row_version),
  };
}
function mapPoLine(r: QueryResultRow): PoLine {
  return {
    poLineId: Number(r.po_line_id), itemId: Number(r.item_id), qty: Number(r.qty),
    receivedQty: Number(r.received_qty), unitRate: Number(r.unit_rate),
    lineAmount: Number(r.line_amount), needByDate: r.need_by_date,
  };
}

const GRN_COLS = `grn_id, grn_no, company_id, bu_id, po_id, vendor_id, grn_date,
  status, created_by, created_at, row_version`;

function mapGrn(r: QueryResultRow): Omit<GoodsReceipt, 'lines'> {
  return {
    grnId: Number(r.grn_id), grnNo: r.grn_no, companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    poId: r.po_id == null ? null : Number(r.po_id), vendorId: Number(r.vendor_id),
    grnDate: r.grn_date, status: r.status,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: r.created_at, rowVersion: Number(r.row_version),
  };
}
function mapGrnLine(r: QueryResultRow): GrnLine {
  return {
    grnLineId: Number(r.grn_line_id),
    poLineId: r.po_line_id == null ? null : Number(r.po_line_id),
    itemId: Number(r.item_id), receivedQty: Number(r.received_qty),
    acceptedQty: Number(r.accepted_qty), rejectedQty: Number(r.rejected_qty),
    warehouseId: Number(r.warehouse_id),
  };
}

// ---- input shapes (service -> repository) ---------------------------------

export interface PrLineInput { itemId: number; qty: number; needByDate?: string }
export interface PrHeaderInput { projectId?: number; wbsId?: number; requiredDate?: string }

export interface PoLineInput { itemId: number; qty: number; unitRate: number; needByDate?: string }
export interface PoHeaderInput { vendorId: number; projectId?: number; prId?: number; expectedDate?: string }

export interface GrnLineInput {
  poLineId?: number; itemId: number; receivedQty: number; acceptedQty?: number; rejectedQty?: number;
}

export class ProcurementRepository {
  constructor(private readonly pool: Pool) {}

  // =========================================================================
  // Purchase Requisition
  // =========================================================================

  private async fetchPrLines(q: Queryable, prId: number): Promise<PrLine[]> {
    const res = await q.query(
      `SELECT pr_line_id, item_id, qty, uom_id, required_date
         FROM scm.pr_line WHERE pr_id = $1 ORDER BY pr_line_id`, [prId]);
    return res.rows.map(mapPrLine);
  }

  async createPr(ctx: RequestContext, h: PrHeaderInput, lines: PrLineInput[]): Promise<PurchaseRequisition> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO scm.purchase_requisition
           (company_id, bu_id, pr_no, project_id, wbs_id, required_date, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE.PR}'),
                 $3,$4,$5,'DRAFT',$6)
         RETURNING ${PR_COLS}`,
        [ctx.companyId, ctx.buId, h.projectId ?? null, h.wbsId ?? null, h.requiredDate ?? null, ctx.userId]);
      const header = mapPr(res.rows[0]);
      for (const l of lines) {
        // pr_line.uom_id is NOT NULL: default to the item's base UOM.
        await c.query(
          `INSERT INTO scm.pr_line (pr_id, item_id, qty, uom_id, required_date)
           VALUES ($1, $2, $3, (SELECT base_uom_id FROM mdm.item WHERE item_id = $2), $4)`,
          [header.prId, l.itemId, l.qty, l.needByDate ?? h.requiredDate ?? null]);
      }
      return { ...header, lines: await this.fetchPrLines(c, header.prId) };
    });
  }

  async findPr(ctx: RequestContext, id: number): Promise<PurchaseRequisition | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${PR_COLS} FROM scm.purchase_requisition
          WHERE pr_id = $1 AND company_id = $2 AND NOT is_deleted`, [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapPr(res.rows[0]), lines: await this.fetchPrLines(c, id) };
    });
  }

  async listPr(ctx: RequestContext, q: PrListQueryDto): Promise<Omit<PurchaseRequisition, 'lines'>[]> {
    const where = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    const offset = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${PR_COLS} FROM scm.purchase_requisition WHERE ${where.join(' AND ')}
          ORDER BY pr_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return res.rows.map(mapPr);
    });
  }

  /** Optimistic status change on the PR; returns null on row_version mismatch. */
  async updatePrStatus(
    ctx: RequestContext, id: number, version: number, status: PrStatus,
  ): Promise<PurchaseRequisition | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE scm.purchase_requisition
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE pr_id = $3 AND company_id = $4 AND row_version = $5 AND NOT is_deleted
        RETURNING ${PR_COLS}`,
        [status, ctx.userId, id, ctx.companyId, version]);
      if (!res.rowCount) return null;
      return { ...mapPr(res.rows[0]), lines: await this.fetchPrLines(c, id) };
    });
  }

  // =========================================================================
  // Purchase Order
  // =========================================================================

  private async fetchPoLines(q: Queryable, poId: number): Promise<PoLine[]> {
    const res = await q.query(
      `SELECT po_line_id, item_id, qty, received_qty, unit_rate, line_amount, need_by_date
         FROM scm.po_line WHERE po_id = $1 ORDER BY po_line_id`, [poId]);
    return res.rows.map(mapPoLine);
  }

  /** Whether a vendor exists in the caller's company AND is approved (gates PO issue). */
  async vendorIsApproved(ctx: RequestContext, vendorId: number): Promise<boolean | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ is_approved: boolean }>(
        `SELECT is_approved FROM mdm.vendor WHERE vendor_id = $1 AND company_id = $2`,
        [vendorId, ctx.companyId]);
      if (!res.rowCount) return null;
      return res.rows[0].is_approved === true;
    });
  }

  async createPo(
    ctx: RequestContext, h: PoHeaderInput, lines: PoLineInput[],
  ): Promise<PurchaseOrder> {
    const total = lines.reduce((s, l) => s + l.qty * l.unitRate, 0);
    return runInContext(this.pool, ctx, async (c) => {
      // purchase_order.currency_id is NOT NULL: default to the company's INR
      // currency (the only seeded currency; matches the customer/item fixtures).
      const res = await c.query(
        `INSERT INTO scm.purchase_order
           (company_id, bu_id, po_no, vendor_id, project_id, currency_id, total_amount,
            expected_date, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE.PO}'),
                 $3,$4, (SELECT currency_id FROM mdm.currency WHERE iso_code='INR'),
                 $5,$6,'DRAFT',$7)
         RETURNING ${PO_COLS}`,
        [ctx.companyId, ctx.buId, h.vendorId, h.projectId ?? null, total, h.expectedDate ?? null, ctx.userId]);
      const header = mapPo(res.rows[0]);
      for (const l of lines) {
        await c.query(
          `INSERT INTO scm.po_line (po_id, item_id, qty, unit_rate, line_amount, need_by_date)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [header.poId, l.itemId, l.qty, l.unitRate, l.qty * l.unitRate, l.needByDate ?? null]);
      }
      // Mark a sourcing PR as consumed (best-effort; keeps the PR lifecycle honest).
      if (h.prId) {
        await c.query(
          `UPDATE scm.purchase_requisition SET status='PO_CREATED', updated_by=$1, updated_at=now(),
                  row_version=row_version+1
            WHERE pr_id=$2 AND company_id=$3 AND status='APPROVED' AND NOT is_deleted`,
          [ctx.userId, h.prId, ctx.companyId]);
      }
      return { ...header, lines: await this.fetchPoLines(c, header.poId) };
    });
  }

  async findPo(ctx: RequestContext, id: number): Promise<PurchaseOrder | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${PO_COLS} FROM scm.purchase_order
          WHERE po_id = $1 AND company_id = $2 AND NOT is_deleted`, [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapPo(res.rows[0]), lines: await this.fetchPoLines(c, id) };
    });
  }

  async listPo(ctx: RequestContext, q: PoListQueryDto): Promise<Omit<PurchaseOrder, 'lines'>[]> {
    const where = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    const offset = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${PO_COLS} FROM scm.purchase_order WHERE ${where.join(' AND ')}
          ORDER BY po_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return res.rows.map(mapPo);
    });
  }

  /**
   * Optimistic status change on the PO. When an `event` is supplied it is written
   * to the outbox in the SAME transaction as the state change (transactional
   * outbox): the relay dispatches it only after commit.
   */
  async updatePoStatus(
    ctx: RequestContext, id: number, version: number, status: PoStatus, event?: OutboxEventInput,
  ): Promise<PurchaseOrder | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE scm.purchase_order
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE po_id = $3 AND company_id = $4 AND row_version = $5 AND NOT is_deleted
        RETURNING ${PO_COLS}`,
        [status, ctx.userId, id, ctx.companyId, version]);
      if (!res.rowCount) return null;
      if (event) await emitOutbox(c, event);
      return { ...mapPo(res.rows[0]), lines: await this.fetchPoLines(c, id) };
    });
  }

  // =========================================================================
  // Goods Receipt Note
  // =========================================================================

  private async fetchGrnLines(q: Queryable, grnId: number): Promise<GrnLine[]> {
    const res = await q.query(
      `SELECT grn_line_id, po_line_id, item_id, received_qty, accepted_qty, rejected_qty, warehouse_id
         FROM scm.grn_line WHERE grn_id = $1 ORDER BY grn_line_id`, [grnId]);
    return res.rows.map(mapGrnLine);
  }

  async findGrn(ctx: RequestContext, id: number): Promise<GoodsReceipt | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${GRN_COLS} FROM scm.goods_receipt
          WHERE grn_id = $1 AND company_id = $2 AND NOT is_deleted`, [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapGrn(res.rows[0]), lines: await this.fetchGrnLines(c, id) };
    });
  }

  async listGrn(ctx: RequestContext, q: GrnListQueryDto): Promise<Omit<GoodsReceipt, 'lines'>[]> {
    const where = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    const offset = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${GRN_COLS} FROM scm.goods_receipt WHERE ${where.join(' AND ')}
          ORDER BY grn_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return res.rows.map(mapGrn);
    });
  }

  /**
   * Receive goods against a PO: create the GRN header (POSTED) + lines and bump
   * the matched po_line.received_qty atomically. The GRN is numbered via the
   * 'GRN' doc series. `vendorId`/`buId` are derived from the parent PO so the GRN
   * always ties back to the right supplier. warehouse_id (NOT NULL on grn_line)
   * is taken from the request or defaulted to the bu's first active warehouse.
   */
  async receiveGrn(
    ctx: RequestContext, poId: number, vendorId: number, warehouseId: number, lines: GrnLineInput[],
  ): Promise<GoodsReceipt> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO scm.goods_receipt
           (company_id, bu_id, grn_no, po_id, vendor_id, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE.GRN}'),
                 $3,$4,'POSTED',$5)
         RETURNING ${GRN_COLS}`,
        [ctx.companyId, ctx.buId, poId, vendorId, ctx.userId]);
      const header = mapGrn(res.rows[0]);
      for (const l of lines) {
        const accepted = l.acceptedQty ?? l.receivedQty;
        const rejected = l.rejectedQty ?? 0;
        await c.query(
          `INSERT INTO scm.grn_line
             (grn_id, po_line_id, item_id, received_qty, accepted_qty, rejected_qty, warehouse_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [header.grnId, l.poLineId ?? null, l.itemId, l.receivedQty, accepted, rejected, warehouseId]);
        if (l.poLineId) {
          await c.query(
            `UPDATE scm.po_line SET received_qty = received_qty + $1
              WHERE po_line_id = $2 AND po_id = $3`,
            [l.receivedQty, l.poLineId, poId]);
        }
      }
      return { ...header, lines: await this.fetchGrnLines(c, header.grnId) };
    });
  }

  /** First active warehouse for the request's business unit (GRN default location). */
  async defaultWarehouseForBu(ctx: RequestContext): Promise<number | null> {
    if (!ctx.buId) return null;
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ warehouse_id: string }>(
        `SELECT warehouse_id FROM mdm.warehouse
          WHERE bu_id = $1 AND is_active ORDER BY warehouse_id LIMIT 1`, [ctx.buId]);
      return res.rowCount ? Number(res.rows[0].warehouse_id) : null;
    });
  }
}
