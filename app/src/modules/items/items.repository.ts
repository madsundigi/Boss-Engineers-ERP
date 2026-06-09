import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { Item, ItemListResult } from './items.types';
import { ItemType } from './items.constants';
import { ListQueryDto } from './items.dto';

/** Columns of mdm.item this module reads/projects. */
const COLS = `item_id, company_id, item_code, item_name, item_category_id, item_type,
  base_uom_id, hsn_sac_id, is_critical, reorder_level,
  created_at, created_by, updated_at, row_version`;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function map(r: QueryResultRow): Item {
  return {
    itemId: Number(r.item_id),
    companyId: Number(r.company_id),
    itemCode: r.item_code,
    itemName: r.item_name,
    categoryId: Number(r.item_category_id),
    type: r.item_type as ItemType,
    baseUomId: Number(r.base_uom_id),
    hsnSacId: num(r.hsn_sac_id),
    isCritical: r.is_critical === true,
    reorderLevel: num(r.reorder_level),
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}

/** Fields the service supplies for create. */
export interface CreateItemRow {
  itemCode: string;
  itemName: string;
  categoryId: number;
  type: ItemType;
  baseUomId: number;
  hsnSacId?: number;
  reorderLevel?: number;
  isCritical?: boolean;
}
/** Mutable fields for update (item_code is immutable). */
export type ItemFields = Partial<Pick<CreateItemRow,
  'itemName' | 'categoryId' | 'type' | 'baseUomId' | 'hsnSacId' | 'reorderLevel' | 'isCritical'>>;

const COL_OF: Record<string, string> = {
  itemName: 'item_name', categoryId: 'item_category_id', type: 'item_type',
  baseUomId: 'base_uom_id', hsnSacId: 'hsn_sac_id', reorderLevel: 'reorder_level',
  isCritical: 'is_critical',
};

/** Thrown by create when the unique item_code constraint (23505) is violated. */
export class DuplicateItemCodeError extends Error {}

export class ItemsRepository {
  constructor(private readonly pool: Pool) {}

  /** Insert an item. company_id = ctx.companyId. A duplicate item_code raises
   *  DuplicateItemCodeError (23505). */
  async create(ctx: RequestContext, data: CreateItemRow): Promise<Item> {
    try {
      return await runInContext(this.pool, ctx, async (c) => {
        const res = await c.query(
          `INSERT INTO mdm.item
             (company_id, item_code, item_name, item_category_id, item_type, base_uom_id,
              hsn_sac_id, is_critical, reorder_level, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING ${COLS}`,
          [ctx.companyId, data.itemCode, data.itemName, data.categoryId, data.type, data.baseUomId,
           data.hsnSacId ?? null, data.isCritical ?? false, data.reorderLevel ?? null, ctx.userId]);
        return map(res.rows[0]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DuplicateItemCodeError();
      throw e;
    }
  }

  async findById(ctx: RequestContext, id: number): Promise<Item | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${COLS} FROM mdm.item WHERE item_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? map(res.rows[0]) : null;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<ItemListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.type) { params.push(q.type); where.push(`item_type = $${params.length}`); }
    if (q.categoryId) { params.push(q.categoryId); where.push(`item_category_id = $${params.length}`); }
    if (q.critical !== undefined) { params.push(q.critical); where.push(`is_critical = $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(item_code ILIKE $${params.length} OR item_name ILIKE $${params.length})`);
    }
    const w = where.join(' AND ');
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM mdm.item WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${COLS} FROM mdm.item WHERE ${w}
          ORDER BY ${q.sort} ${dir}, item_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(map);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked field update. Returns null on a row-version mismatch. */
  async update(ctx: RequestContext, id: number, version: number, fields: ItemFields): Promise<Item | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(v); set.push(`${COL_OF[k]} = $${params.length}`);
    }
    if (set.length === 0) return this.findById(ctx, id);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(ctx.userId); const pUser = params.length;
      params.push(id); const pId = params.length;
      params.push(version); const pVer = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      const res = await c.query(
        `UPDATE mdm.item
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE item_id = $${pId} AND row_version = $${pVer} AND company_id = $${pCo} AND NOT is_deleted
          RETURNING ${COLS}`, params);
      return res.rowCount ? map(res.rows[0]) : null;
    });
  }

  /** Soft delete under optimistic lock. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE mdm.item
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE item_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted`,
        [ctx.userId, id, version, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
