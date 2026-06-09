import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { WorkCenter, WorkCenterListResult } from './workcenters.types';
import { ListQueryDto } from './workcenters.dto';

/**
 * Columns of mdm.work_center, qualified `wc.`, plus the parent company_id from
 * mdm.business_unit (the work_center row carries no company_id of its own). Every query
 * joins mdm.business_unit so the result is tenant-scoped by bu.company_id.
 */
const W = `wc.wc_id, wc.bu_id, bu.company_id, wc.wc_code, wc.wc_name,
  wc.capacity_per_day, wc.cost_rate, wc.is_active`;

function mapWc(r: QueryResultRow): WorkCenter {
  return {
    wcId: Number(r.wc_id),
    buId: Number(r.bu_id),
    companyId: Number(r.company_id),
    wcCode: r.wc_code,
    wcName: r.wc_name,
    capacityPerDay: Number(r.capacity_per_day),
    costRate: Number(r.cost_rate),
    isActive: r.is_active === true,
  };
}

/** Fields the service supplies for create. */
export interface CreateWorkCenterRow {
  buId: number;
  wcCode: string;
  wcName: string;
  capacityPerDay?: number;
  costRate?: number;
  isActive?: boolean;
}
/** Mutable fields for update (wc_code is immutable). */
export type WorkCenterFields = Partial<Pick<CreateWorkCenterRow,
  'buId' | 'wcName' | 'capacityPerDay' | 'costRate' | 'isActive'>>;

const COL_OF: Record<string, string> = {
  buId: 'bu_id', wcName: 'wc_name', capacityPerDay: 'capacity_per_day',
  costRate: 'cost_rate', isActive: 'is_active',
};

/** Thrown by create when the UNIQUE wc_code (23505) is violated. */
export class DuplicateWorkCenterCodeError extends Error {}

/** Thrown by delete when a FK (23503) still references the work centre (routings / WOs). */
export class WorkCenterInUseError extends Error {}

export class WorkCentersRepository {
  constructor(private readonly pool: Pool) {}

  /** True if the business unit exists and belongs to the caller's company. The service
   *  uses this to reject a create/move that points at another tenant's BU. */
  async buBelongsToCompany(ctx: RequestContext, buId: number): Promise<boolean> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT 1 FROM mdm.business_unit WHERE bu_id = $1 AND company_id = $2`,
        [buId, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  /** Insert a work centre. The caller (service) has already verified buId is in-tenant.
   *  A duplicate wc_code raises DuplicateWorkCenterCodeError. */
  async create(ctx: RequestContext, data: CreateWorkCenterRow): Promise<WorkCenter> {
    try {
      return await runInContext(this.pool, ctx, async (c) => {
        const res = await c.query(
          `INSERT INTO mdm.work_center (bu_id, wc_code, wc_name, capacity_per_day, cost_rate, is_active)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING wc_id`,
          [data.buId, data.wcCode, data.wcName, data.capacityPerDay ?? 0,
           data.costRate ?? 0, data.isActive ?? true]);
        // Re-read through the company-scoped join so companyId is populated consistently.
        const wcId = Number(res.rows[0].wc_id);
        const full = await c.query(
          `SELECT ${W} FROM mdm.work_center wc
             JOIN mdm.business_unit bu ON bu.bu_id = wc.bu_id
            WHERE wc.wc_id = $1 AND bu.company_id = $2`,
          [wcId, ctx.companyId]);
        return mapWc(full.rows[0]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DuplicateWorkCenterCodeError();
      throw e;
    }
  }

  /** Lookup scoped to the tenant via the BU join; null when missing or cross-tenant. */
  async findById(ctx: RequestContext, id: number): Promise<WorkCenter | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${W} FROM mdm.work_center wc
           JOIN mdm.business_unit bu ON bu.bu_id = wc.bu_id
          WHERE wc.wc_id = $1 AND bu.company_id = $2`,
        [id, ctx.companyId]);
      return res.rowCount ? mapWc(res.rows[0]) : null;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<WorkCenterListResult> {
    const where: string[] = ['bu.company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.buId !== undefined) { params.push(q.buId); where.push(`wc.bu_id = $${params.length}`); }
    if (q.active !== undefined) { params.push(q.active); where.push(`wc.is_active = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(wc.wc_code ILIKE $${params.length} OR wc.wc_name ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM mdm.work_center wc
           JOIN mdm.business_unit bu ON bu.bu_id = wc.bu_id WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${W} FROM mdm.work_center wc
           JOIN mdm.business_unit bu ON bu.bu_id = wc.bu_id WHERE ${w}
          ORDER BY wc.${q.sort} ${dir}, wc.wc_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapWc);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Field update. The table has no row_version, so the WHERE clause re-scopes the row to
   * the tenant via an EXISTS on the parent BU (a cross-tenant id never matches). Returns
   * null when no in-tenant row was updated. The caller (service) has already verified any
   * new buId is in-tenant.
   */
  async update(ctx: RequestContext, id: number, fields: WorkCenterFields): Promise<WorkCenter | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(v); set.push(`${COL_OF[k]} = $${params.length}`);
    }
    if (set.length === 0) return this.findById(ctx, id);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      const res = await c.query(
        `UPDATE mdm.work_center wc
            SET ${set.join(', ')}
          WHERE wc.wc_id = $${pId}
            AND EXISTS (SELECT 1 FROM mdm.business_unit bu
                         WHERE bu.bu_id = wc.bu_id AND bu.company_id = $${pCo})
          RETURNING wc.wc_id`, params);
      if (!res.rowCount) return null;
      // Re-read on the SAME client (not findById, which opens a separate connection
      // that wouldn't see this still-uncommitted UPDATE).
      const full = await c.query(
        `SELECT ${W} FROM mdm.work_center wc
           JOIN mdm.business_unit bu ON bu.bu_id = wc.bu_id
          WHERE wc.wc_id = $1 AND bu.company_id = $2`,
        [id, ctx.companyId]);
      return full.rowCount ? mapWc(full.rows[0]) : null;
    });
  }

  /**
   * Hard delete (the table has no is_deleted). Scoped to the tenant via an EXISTS on the
   * parent BU. Returns true if an in-tenant row was removed. A FK from
   * mdm.routing_operation / mfg.work_order_operation may raise 23503, which the service
   * maps to a 409 (the work centre is still referenced by routings / work orders).
   */
  async delete(ctx: RequestContext, id: number): Promise<boolean> {
    try {
      return await runInContext(this.pool, ctx, async (c) => {
        const res = await c.query(
          `DELETE FROM mdm.work_center wc
            WHERE wc.wc_id = $1
              AND EXISTS (SELECT 1 FROM mdm.business_unit bu
                           WHERE bu.bu_id = wc.bu_id AND bu.company_id = $2)`,
          [id, ctx.companyId]);
        return (res.rowCount ?? 0) > 0;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new WorkCenterInUseError();
      throw e;
    }
  }
}
