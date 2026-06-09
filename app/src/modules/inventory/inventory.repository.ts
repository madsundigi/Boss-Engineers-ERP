import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import {
  StockRow, StockListResult, StockAdjustment, Reservation, MaterialIssue, CriticalItemRow,
} from './inventory.types';
import {
  StockListQueryDto, CreateAdjustmentDto, CreateReservationDto, CreateIssueDto, CriticalListQueryDto,
} from './inventory.dto';
import { REF_DOC, StockTxnType } from './inventory.constants';

// ---- row mappers ---------------------------------------------------------

function mapStock(r: QueryResultRow): StockRow {
  return {
    stockId: Number(r.stock_id),
    companyId: Number(r.company_id),
    itemId: Number(r.item_id),
    itemCode: r.item_code,
    itemName: r.item_name,
    minLevel: r.min_level == null ? null : Number(r.min_level),
    reorderLevel: r.reorder_level == null ? null : Number(r.reorder_level),
    warehouseId: Number(r.warehouse_id),
    warehouseCode: r.wh_code ?? null,
    binId: r.bin_id == null ? null : Number(r.bin_id),
    batchId: r.batch_id == null ? null : Number(r.batch_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    qtyOnHand: Number(r.qty_on_hand),
    qtyReserved: Number(r.qty_reserved),
    qtyAvailable: Number(r.qty_available),
    avgCost: Number(r.avg_cost),
    updatedAt: r.updated_at,
  };
}

const ADJ_COLS = `adj_id, company_id, item_id, warehouse_id, project_id, adj_type, qty,
  unit_cost, reason, status, approved_by, approved_at, created_at, created_by, row_version`;

function mapAdjustment(r: QueryResultRow): StockAdjustment {
  return {
    adjId: Number(r.adj_id),
    companyId: Number(r.company_id),
    itemId: Number(r.item_id),
    warehouseId: Number(r.warehouse_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    adjType: r.adj_type,
    qty: Number(r.qty),
    unitCost: Number(r.unit_cost),
    reason: r.reason,
    status: r.status,
    approvedBy: r.approved_by == null ? null : Number(r.approved_by),
    approvedAt: r.approved_at,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    rowVersion: Number(r.row_version),
  };
}

function mapReservation(r: QueryResultRow): Reservation {
  return {
    reservationId: Number(r.reservation_id),
    projectId: Number(r.project_id),
    wbsId: r.wbs_id == null ? null : Number(r.wbs_id),
    itemId: Number(r.item_id),
    qty: Number(r.qty),
    warehouseId: Number(r.warehouse_id),
    status: r.status,
    reservedAt: r.reserved_at,
  };
}

function mapIssue(r: QueryResultRow): MaterialIssue {
  return {
    issueId: Number(r.issue_id),
    companyId: Number(r.company_id),
    issueNo: r.issue_no,
    projectId: Number(r.project_id),
    woId: r.wo_id == null ? null : Number(r.wo_id),
    itemId: Number(r.item_id),
    qty: Number(r.qty),
    warehouseId: Number(r.warehouse_id),
    unitCost: Number(r.unit_cost),
    issueDate: r.issue_date,
    createdAt: r.created_at,
  };
}

function mapCritical(r: QueryResultRow): CriticalItemRow {
  return {
    critId: Number(r.crit_id),
    itemId: Number(r.item_id),
    itemCode: r.item_code,
    itemName: r.item_name,
    projectId: Number(r.project_id),
    projectNo: r.project_no ?? null,
    reason: r.reason,
    status: r.status,
    orderByDate: r.order_by_date,
    leadTimeDays: Number(r.lead_time_days),
    qtyAvailable: Number(r.qty_available),
    earlyWarning: r.early_warning === true,
  };
}

/** Result of an atomic stock mutation: ok=false means the availability guard rejected it. */
export interface StockMutationResult {
  ok: boolean;
  available: number; // available qty observed for the targeted balance (0 if no row)
}

export class InventoryRepository {
  constructor(private readonly pool: Pool) {}

  // ---- Stock balances (free vs reserved) --------------------------------

  async listStock(ctx: RequestContext, q: StockListQueryDto): Promise<StockListResult> {
    const where: string[] = ['s.company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.itemId) { params.push(q.itemId); where.push(`s.item_id = $${params.length}`); }
    if (q.warehouseId) { params.push(q.warehouseId); where.push(`s.warehouse_id = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`s.project_id = $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`);
      const i = params.length;
      where.push(`(i.item_code ILIKE $${i} OR i.item_name ILIKE $${i})`);
    }
    if (q.onlyAvailable) where.push('s.qty_available > 0');
    const whereSql = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const totalRes = await c.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM scm.item_stock s JOIN mdm.item i ON i.item_id = s.item_id
          WHERE ${whereSql}`,
        params,
      );
      const total = Number(totalRes.rows[0].total);

      const rowsRes = await c.query(
        `SELECT s.stock_id, s.company_id, s.item_id, i.item_code, i.item_name,
                i.min_level, i.reorder_level,
                s.warehouse_id, w.wh_code, s.bin_id, s.batch_id, s.project_id,
                s.qty_on_hand, s.qty_reserved, s.qty_available, s.avg_cost, s.updated_at
           FROM scm.item_stock s
           JOIN mdm.item i      ON i.item_id = s.item_id
           LEFT JOIN mdm.warehouse w ON w.warehouse_id = s.warehouse_id
          WHERE ${whereSql}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()}, s.stock_id
          LIMIT ${q.pageSize} OFFSET ${offset}`,
        params,
      );
      return { rows: rowsRes.rows.map(mapStock), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Sum the available (on hand - reserved) for an item at a warehouse, company-scoped. */
  async availableFor(ctx: RequestContext, itemId: number, warehouseId: number): Promise<number> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ avail: string | null }>(
        `SELECT COALESCE(SUM(qty_available), 0)::text AS avail
           FROM scm.item_stock
          WHERE company_id = $1 AND item_id = $2 AND warehouse_id = $3`,
        [ctx.companyId, itemId, warehouseId],
      );
      return Number(res.rows[0].avail ?? 0);
    });
  }

  // ---- Stock adjustment / receipt / write-off ---------------------------

  async createAdjustment(ctx: RequestContext, data: CreateAdjustmentDto): Promise<StockAdjustment> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO scm.stock_adjustment
           (company_id, item_id, warehouse_id, project_id, adj_type, qty, unit_cost,
            reason, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9)
         RETURNING ${ADJ_COLS}`,
        [
          ctx.companyId, data.itemId, data.warehouseId, data.projectId ?? null,
          data.adjType, data.qty, data.unitCost, data.reason ?? null, ctx.userId,
        ],
      );
      return mapAdjustment(res.rows[0]);
    });
  }

  async findAdjustment(ctx: RequestContext, id: number): Promise<StockAdjustment | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${ADJ_COLS} FROM scm.stock_adjustment
          WHERE adj_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId],
      );
      return res.rowCount ? mapAdjustment(res.rows[0]) : null;
    });
  }

  async listAdjustments(ctx: RequestContext, limit = 50): Promise<StockAdjustment[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${ADJ_COLS} FROM scm.stock_adjustment
          WHERE company_id = $1 AND NOT is_deleted
          ORDER BY adj_id DESC LIMIT ${limit}`,
        [ctx.companyId],
      );
      return res.rows.map(mapAdjustment);
    });
  }

  /**
   * Approve + post an adjustment to stock atomically. Optimistic concurrency on
   * row_version: returns null if the version did not match (someone else moved it).
   * RECEIPT/ADJUST add qty to on-hand; WRITE_OFF removes it (guarded by caller).
   * The item_stock balance is upserted and a signed ledger row is appended.
   */
  async approveAndPostAdjustment(
    ctx: RequestContext, id: number, expectedVersion: number,
  ): Promise<StockAdjustment | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const upd = await c.query(
        `UPDATE scm.stock_adjustment
            SET status = 'POSTED', approved_by = $1, approved_at = now(),
                updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE adj_id = $2 AND company_id = $3 AND row_version = $4
            AND status = 'DRAFT' AND NOT is_deleted
        RETURNING ${ADJ_COLS}`,
        [ctx.userId, id, ctx.companyId, expectedVersion],
      );
      if (!upd.rowCount) return null;
      const adj = mapAdjustment(upd.rows[0]);

      const signed = adj.adjType === 'WRITE_OFF' ? -adj.qty : adj.qty;

      // Apply to the on-hand balance for this (item, warehouse, project, free bin/batch)
      // bucket. Done as UPDATE-then-INSERT (rather than ON CONFLICT) because the base
      // uq_item_stock index treats NULL bin/batch/project as DISTINCT, so a plain
      // ON CONFLICT would not match an existing free-stock (NULL-project) row.
      const bump = await c.query(
        `UPDATE scm.item_stock
            SET qty_on_hand = qty_on_hand + $5, updated_at = now()
          WHERE company_id = $1 AND item_id = $2 AND warehouse_id = $3
            AND project_id IS NOT DISTINCT FROM $4
            AND bin_id IS NULL AND batch_id IS NULL`,
        [adj.companyId, adj.itemId, adj.warehouseId, adj.projectId, signed],
      );
      if (!bump.rowCount) {
        await c.query(
          `INSERT INTO scm.item_stock
             (company_id, item_id, warehouse_id, project_id, qty_on_hand, avg_cost)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [adj.companyId, adj.itemId, adj.warehouseId, adj.projectId, signed, adj.unitCost],
        );
      }

      await this.appendLedger(c, ctx, {
        itemId: adj.itemId, warehouseId: adj.warehouseId, projectId: adj.projectId,
        txnType: 'ADJUST', qty: signed, unitCost: adj.unitCost,
        refType: REF_DOC.ADJUSTMENT, refId: adj.adjId,
      });
      return adj;
    });
  }

  async rejectAdjustment(
    ctx: RequestContext, id: number, expectedVersion: number,
  ): Promise<StockAdjustment | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE scm.stock_adjustment
            SET status = 'REJECTED', updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE adj_id = $2 AND company_id = $3 AND row_version = $4
            AND status = 'DRAFT' AND NOT is_deleted
        RETURNING ${ADJ_COLS}`,
        [ctx.userId, id, ctx.companyId, expectedVersion],
      );
      return res.rowCount ? mapAdjustment(res.rows[0]) : null;
    });
  }

  // ---- Reservation (reserve to project) ---------------------------------

  /**
   * Reserve qty against a project. The bump of qty_reserved is conditional on
   * sufficient availability (qty_on_hand - qty_reserved >= qty) for an item at a
   * warehouse, evaluated atomically so two concurrent reservers cannot oversell.
   * ok=false => insufficient available stock (caller maps to 409).
   */
  async reserve(ctx: RequestContext, data: CreateReservationDto): Promise<{ result: StockMutationResult; reservation?: Reservation }> {
    return runInContext(this.pool, ctx, async (c) => {
      // Atomically claim availability on the best-matching balance row.
      const claim = await c.query<{ stock_id: string }>(
        `UPDATE scm.item_stock
            SET qty_reserved = qty_reserved + $4, updated_at = now()
          WHERE stock_id = (
            SELECT stock_id FROM scm.item_stock
             WHERE company_id = $1 AND item_id = $2 AND warehouse_id = $3
               AND (qty_on_hand - qty_reserved) >= $4
             ORDER BY (project_id IS NULL) DESC, qty_available DESC
             LIMIT 1
             FOR UPDATE
          )
        RETURNING stock_id`,
        [ctx.companyId, data.itemId, data.warehouseId, data.qty],
      );
      if (!claim.rowCount) {
        const avail = await c.query<{ avail: string | null }>(
          `SELECT COALESCE(SUM(qty_available),0)::text AS avail FROM scm.item_stock
            WHERE company_id = $1 AND item_id = $2 AND warehouse_id = $3`,
          [ctx.companyId, data.itemId, data.warehouseId],
        );
        return { result: { ok: false, available: Number(avail.rows[0].avail ?? 0) } };
      }

      const head = await c.query(
        `INSERT INTO scm.material_reservation (project_id, wbs_id, status)
         VALUES ($1,$2,'OPEN') RETURNING reservation_id, project_id, wbs_id, status, reserved_at`,
        [data.projectId, data.wbsId ?? null],
      );
      const reservationId = Number(head.rows[0].reservation_id);
      await c.query(
        `INSERT INTO scm.reservation_line (reservation_id, item_id, qty, warehouse_id)
         VALUES ($1,$2,$3,$4)`,
        [reservationId, data.itemId, data.qty, data.warehouseId],
      );

      await this.appendLedger(c, ctx, {
        itemId: data.itemId, warehouseId: data.warehouseId, projectId: data.projectId,
        txnType: 'RESERVE', qty: data.qty, unitCost: 0, refType: REF_DOC.RESERVATION, refId: reservationId,
      });

      const reservation: Reservation = {
        reservationId,
        projectId: Number(head.rows[0].project_id),
        wbsId: head.rows[0].wbs_id == null ? null : Number(head.rows[0].wbs_id),
        itemId: data.itemId,
        qty: data.qty,
        warehouseId: data.warehouseId,
        status: head.rows[0].status,
        reservedAt: head.rows[0].reserved_at,
      };
      return { result: { ok: true, available: 0 }, reservation };
    });
  }

  // ---- Material issue (consume stock) -----------------------------------

  /**
   * Issue qty to a project / work order. The on-hand decrement is conditional on
   * qty_on_hand >= qty for the targeted balance, evaluated atomically so an issue
   * can never drive stock negative (over-issue). Releases any reservation it
   * consumes (qty_reserved is reduced, floored at 0). ok=false => short stock.
   */
  async issue(ctx: RequestContext, data: CreateIssueDto): Promise<{ result: StockMutationResult; issue?: MaterialIssue }> {
    return runInContext(this.pool, ctx, async (c) => {
      const claim = await c.query<{ stock_id: string }>(
        `UPDATE scm.item_stock
            SET qty_on_hand  = qty_on_hand - $4,
                qty_reserved = GREATEST(qty_reserved - $4, 0),
                updated_at   = now()
          WHERE stock_id = (
            SELECT stock_id FROM scm.item_stock
             WHERE company_id = $1 AND item_id = $2 AND warehouse_id = $3
               AND qty_on_hand >= $4
             ORDER BY (project_id IS NOT DISTINCT FROM $5) DESC, qty_on_hand DESC
             LIMIT 1
             FOR UPDATE
          )
        RETURNING stock_id`,
        [ctx.companyId, data.itemId, data.warehouseId, data.qty, data.projectId],
      );
      if (!claim.rowCount) {
        const onHand = await c.query<{ qty: string | null }>(
          `SELECT COALESCE(SUM(qty_on_hand),0)::text AS qty FROM scm.item_stock
            WHERE company_id = $1 AND item_id = $2 AND warehouse_id = $3`,
          [ctx.companyId, data.itemId, data.warehouseId],
        );
        return { result: { ok: false, available: Number(onHand.rows[0].qty ?? 0) } };
      }

      const head = await c.query(
        `INSERT INTO scm.material_issue
           (company_id, issue_no, project_id, wo_id, created_by)
         VALUES ($1, 'MI-' || lpad(nextval('scm.seq_material_issue_no')::text, 6, '0'),
                 $2, $3, $4)
         RETURNING issue_id, company_id, issue_no, project_id, wo_id, issue_date, created_at`,
        [ctx.companyId, data.projectId, data.woId ?? null, ctx.userId],
      );
      const issueId = Number(head.rows[0].issue_id);
      await c.query(
        `INSERT INTO scm.material_issue_line (issue_id, item_id, qty, warehouse_id, unit_cost)
         VALUES ($1,$2,$3,$4,$5)`,
        [issueId, data.itemId, data.qty, data.warehouseId, data.unitCost],
      );

      await this.appendLedger(c, ctx, {
        itemId: data.itemId, warehouseId: data.warehouseId, projectId: data.projectId,
        txnType: 'ISSUE', qty: -data.qty, unitCost: data.unitCost, refType: REF_DOC.ISSUE, refId: issueId,
      });

      const issue: MaterialIssue = {
        issueId,
        companyId: Number(head.rows[0].company_id),
        issueNo: head.rows[0].issue_no,
        projectId: Number(head.rows[0].project_id),
        woId: head.rows[0].wo_id == null ? null : Number(head.rows[0].wo_id),
        itemId: data.itemId,
        qty: data.qty,
        warehouseId: data.warehouseId,
        unitCost: data.unitCost,
        issueDate: head.rows[0].issue_date,
        createdAt: head.rows[0].created_at,
      };
      return { result: { ok: true, available: 0 }, issue };
    });
  }

  // ---- Critical-item register (early-warning) ---------------------------

  async listCritical(ctx: RequestContext, q: CriticalListQueryDto): Promise<CriticalItemRow[]> {
    const where: string[] = ['p.company_id = $1', 'i.is_critical = true'];
    const params: unknown[] = [ctx.companyId];
    if (q.projectId) { params.push(q.projectId); where.push(`ci.project_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`ci.status = $${params.length}`); }
    const whereSql = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    // early_warning: not yet ordered AND (order_by_date already due, or it falls
    // within the item's lead time from today -> must order now).
    const havingWarning = q.warningOnly ? 'WHERE ew.early_warning' : '';

    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT * FROM (
           SELECT ci.crit_id, ci.item_id, i.item_code, i.item_name, ci.project_id,
                  p.project_no, ci.reason, ci.status, ci.order_by_date, i.lead_time_days,
                  COALESCE(st.qty_available, 0) AS qty_available,
                  (ci.status IN ('OPEN','AT_RISK')
                    AND ci.order_by_date IS NOT NULL
                    AND ci.order_by_date <= (current_date + (i.lead_time_days || ' days')::interval)
                  ) AS early_warning
             FROM scm.critical_item ci
             JOIN mdm.item i    ON i.item_id = ci.item_id
             JOIN proj.project p ON p.project_id = ci.project_id
             LEFT JOIN LATERAL (
               SELECT SUM(qty_available) AS qty_available
                 FROM scm.item_stock s
                WHERE s.item_id = ci.item_id AND s.company_id = p.company_id
             ) st ON true
            WHERE ${whereSql}
         ) ew
         ${havingWarning}
         ORDER BY ew.early_warning DESC, ew.order_by_date NULLS LAST
         LIMIT ${q.pageSize} OFFSET ${offset}`,
        params,
      );
      return res.rows.map(mapCritical);
    });
  }

  // ---- internal: immutable ledger append --------------------------------

  private async appendLedger(
    c: Queryable, ctx: RequestContext,
    t: { itemId: number; warehouseId: number; projectId: number | null; txnType: StockTxnType;
         qty: number; unitCost: number; refType: string; refId: number },
  ): Promise<void> {
    await c.query(
      `INSERT INTO scm.stock_transaction
         (company_id, item_id, warehouse_id, txn_type, qty, unit_cost, project_id,
          ref_doc_type, ref_doc_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ctx.companyId, t.itemId, t.warehouseId, t.txnType, t.qty, t.unitCost,
        t.projectId, t.refType, t.refId, ctx.userId,
      ],
    );
  }
}
