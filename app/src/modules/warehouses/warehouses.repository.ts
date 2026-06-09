import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { Warehouse, WarehouseListResult } from './warehouses.types';
import { ListQueryDto } from './warehouses.dto';

/**
 * Columns selected for a warehouse. mdm.warehouse has no company_id, so the parent
 * business unit's company_id is joined in as w_company_id. The SELECTs always join
 * mdm.business_unit and filter bu.company_id = ctx.companyId — that JOIN is the tenant
 * gate (the warehouse row carries no tenant key of its own).
 */
const W = `w.warehouse_id, w.bu_id, w.wh_code, w.wh_name, w.is_active, bu.company_id AS w_company_id`;

function mapWarehouse(r: QueryResultRow): Warehouse {
  return {
    warehouseId: Number(r.warehouse_id),
    buId: Number(r.bu_id),
    whCode: r.wh_code,
    whName: r.wh_name,
    isActive: r.is_active === true,
    companyId: Number(r.w_company_id),
  };
}

/** Fields the service supplies for create. */
export interface CreateWarehouseRow {
  buId: number;
  whCode: string;
  whName: string;
  isActive?: boolean;
}
/** Mutable fields for update (bu_id and wh_code are immutable). */
export type WarehouseFields = Partial<Pick<CreateWarehouseRow, 'whName' | 'isActive'>>;

const COL_OF: Record<string, string> = { whName: 'wh_name', isActive: 'is_active' };

/** Thrown by create when uq_wh (bu_id, wh_code) is violated (23505). */
export class DuplicateWarehouseCodeError extends Error {}
/** Thrown by create when bu_id is not a live BU in the caller's company. */
export class BusinessUnitNotFoundError extends Error {}
/** Thrown by delete when the warehouse is still referenced (FK 23503). */
export class WarehouseInUseError extends Error {}

export class WarehousesRepository {
  constructor(private readonly pool: Pool) {}

  /** True if bu_id is a business unit in the caller's company (the tenant gate for
   *  create, since the new warehouse row has no company_id to check against RLS). */
  private async buInCompany(c: Queryable, buId: number, companyId: number): Promise<boolean> {
    const res = await c.query(
      `SELECT 1 FROM mdm.business_unit WHERE bu_id = $1 AND company_id = $2`, [buId, companyId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Insert a warehouse under a business unit. The bu must belong to the caller's
   * company (BusinessUnitNotFoundError otherwise). A duplicate (bu_id, wh_code) raises
   * DuplicateWarehouseCodeError.
   */
  async create(ctx: RequestContext, data: CreateWarehouseRow): Promise<Warehouse> {
    try {
      return await runInContext(this.pool, ctx, async (c) => {
        if (!(await this.buInCompany(c, data.buId, ctx.companyId))) {
          throw new BusinessUnitNotFoundError();
        }
        const res = await c.query(
          `WITH ins AS (
             INSERT INTO mdm.warehouse (bu_id, wh_code, wh_name, is_active)
             VALUES ($1, $2, $3, $4)
             RETURNING warehouse_id, bu_id, wh_code, wh_name, is_active
           )
           SELECT ins.warehouse_id, ins.bu_id, ins.wh_code, ins.wh_name, ins.is_active,
                  bu.company_id AS w_company_id
             FROM ins JOIN mdm.business_unit bu ON bu.bu_id = ins.bu_id`,
          [data.buId, data.whCode, data.whName, data.isActive ?? true]);
        return mapWarehouse(res.rows[0]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DuplicateWarehouseCodeError();
      throw e;
    }
  }

  async findById(ctx: RequestContext, id: number): Promise<Warehouse | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${W} FROM mdm.warehouse w
           JOIN mdm.business_unit bu ON bu.bu_id = w.bu_id
          WHERE w.warehouse_id = $1 AND bu.company_id = $2`,
        [id, ctx.companyId]);
      return res.rowCount ? mapWarehouse(res.rows[0]) : null;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<WarehouseListResult> {
    const where: string[] = ['bu.company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.buId !== undefined) { params.push(q.buId); where.push(`w.bu_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(w.wh_code ILIKE $${params.length} OR w.wh_name ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM mdm.warehouse w
           JOIN mdm.business_unit bu ON bu.bu_id = w.bu_id WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${W} FROM mdm.warehouse w
           JOIN mdm.business_unit bu ON bu.bu_id = w.bu_id
          WHERE ${w}
          ORDER BY w.${q.sort} ${dir}, w.warehouse_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapWarehouse);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Plain field update (no optimistic concurrency — the table has no row_version).
   * The bu-company JOIN keeps the write tenant-scoped. Returns null if the warehouse
   * is not in the caller's company, or the refreshed row otherwise.
   */
  async update(ctx: RequestContext, id: number, fields: WarehouseFields): Promise<Warehouse | null> {
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
        `WITH upd AS (
           UPDATE mdm.warehouse w
              SET ${set.join(', ')}
             FROM mdm.business_unit bu
            WHERE w.bu_id = bu.bu_id AND w.warehouse_id = $${pId} AND bu.company_id = $${pCo}
            RETURNING w.warehouse_id, w.bu_id, w.wh_code, w.wh_name, w.is_active, bu.company_id AS w_company_id
         )
         SELECT * FROM upd`, params);
      return res.rowCount ? mapWarehouse(res.rows[0]) : null;
    });
  }

  /**
   * Hard delete (mdm.warehouse has no is_deleted column). Tenant-scoped via the
   * bu-company JOIN. Returns true if a row was removed. A warehouse still referenced
   * by stock/bins is protected by the FK — the 23503 surfaces as WarehouseInUseError.
   */
  async hardDelete(ctx: RequestContext, id: number): Promise<boolean> {
    try {
      return await runInContext(this.pool, ctx, async (c) => {
        const res = await c.query(
          `DELETE FROM mdm.warehouse w
            USING mdm.business_unit bu
            WHERE w.bu_id = bu.bu_id AND w.warehouse_id = $1 AND bu.company_id = $2`,
          [id, ctx.companyId]);
        return (res.rowCount ?? 0) > 0;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new WarehouseInUseError();
      throw e;
    }
  }
}
