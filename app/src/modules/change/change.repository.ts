import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { ChangeOrder, ChangeOrderListResult } from './change.types';
import { ListQueryDto } from './change.dto';
import { DOC_TYPE, ChangeStatus } from './change.constants';

/** Header columns of proj.change_order (bu_id + reason added in migration 025). */
const H = `change_order_id, co_no, company_id, bu_id, project_id, description, reason,
  cost_impact, price_impact, schedule_impact_days, status,
  created_at, created_by, updated_at, updated_by, row_version`;

function mapRow(r: QueryResultRow): ChangeOrder {
  return {
    changeOrderId: Number(r.change_order_id),
    changeNo: r.co_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    projectId: Number(r.project_id),
    description: r.description,
    reason: r.reason,
    costImpact: Number(r.cost_impact),
    priceImpact: Number(r.price_impact),
    scheduleImpactDays: Number(r.schedule_impact_days),
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    updatedBy: r.updated_by == null ? null : Number(r.updated_by),
    rowVersion: Number(r.row_version),
  };
}

export interface ChangeOrderInput {
  projectId: number;
  description: string;
  reason?: string;
  costImpact: number;
  priceImpact: number;
  scheduleImpactDays: number;
}

/** A partial header patch carried alongside a status change (e.g. a reject reason). */
export type StatusPatch = Partial<Record<'reason', unknown>>;

export class ChangeOrderRepository {
  constructor(private readonly pool: Pool) {}

  /** Insert, allocating the gapless change-order number inside the same transaction. */
  async create(ctx: RequestContext, h: ChangeOrderInput): Promise<ChangeOrder> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO proj.change_order
           (company_id, bu_id, co_no, project_id, description, reason,
            cost_impact, price_impact, schedule_impact_days, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,$7,$8, 'DRAFT', $9)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.projectId, h.description, h.reason ?? null,
          h.costImpact, h.priceImpact, h.scheduleImpactDays, ctx.userId,
        ]);
      return mapRow(res.rows[0]);
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<ChangeOrder | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM proj.change_order
          WHERE change_order_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return mapRow(res.rows[0]);
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<ChangeOrderListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`co_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM proj.change_order WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM proj.change_order WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapRow), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked header update (DRAFT amend). Null on a row-version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number, fields: Partial<ChangeOrderInput>,
  ): Promise<ChangeOrder | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.description !== undefined) add('description', fields.description);
    if (fields.reason !== undefined) add('reason', fields.reason);
    if (fields.costImpact !== undefined) add('cost_impact', fields.costImpact);
    if (fields.priceImpact !== undefined) add('price_impact', fields.priceImpact);
    if (fields.scheduleImpactDays !== undefined) add('schedule_impact_days', fields.scheduleImpactDays);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE proj.change_order
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE change_order_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      return mapRow(res.rows[0]);
    });
  }

  /**
   * Lifecycle status change with an optional patch (e.g. a reject reason) and an
   * optional outbox event (e.g. 'change_order.approved' on approval) emitted
   * atomically with the state change. Returns null on a row-version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: ChangeStatus,
    patch: StatusPatch = {}, event?: OutboxEventInput,
  ): Promise<ChangeOrder | null> {
    const set: string[] = ['status = $1'];
    const params: unknown[] = [status];
    for (const [col, val] of Object.entries(patch)) { params.push(val); set.push(`${col} = $${params.length}`); }
    params.push(ctx.userId); set.push(`updated_by = $${params.length}`);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE proj.change_order SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE change_order_id = $${pId} AND company_id = $${pCo} AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      // Atomic with the state change: record the domain event (transactional outbox).
      if (event) await emitOutbox(c, event);
      return mapRow(res.rows[0]);
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE proj.change_order
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE change_order_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
