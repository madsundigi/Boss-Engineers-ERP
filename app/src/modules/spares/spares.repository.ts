import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { SparePart, SpareStock, SparePartListResult, LowStockRow } from './spares.types';
import { ListQueryDto } from './spares.dto';

/** Catalog columns of svc.spare_part (created in migration 032). */
const P = `spare_id, company_id, part_code, part_name, uom, item_id, unit_price,
  reorder_level, is_active, created_at, created_by, updated_at, row_version`;

/** Per-location stock columns of svc.spare_stock. */
const S = `stock_id, spare_id, location, qty_on_hand`;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function mapPart(r: QueryResultRow): SparePart {
  return {
    spareId: Number(r.spare_id),
    companyId: Number(r.company_id),
    partCode: r.part_code,
    partName: r.part_name,
    uom: (r.uom as string) ?? null,
    itemId: num(r.item_id),
    unitPrice: Number(r.unit_price),
    reorderLevel: Number(r.reorder_level),
    isActive: r.is_active === true,
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}
function mapStock(r: QueryResultRow): SpareStock {
  return {
    stockId: Number(r.stock_id),
    spareId: Number(r.spare_id),
    location: r.location,
    qtyOnHand: Number(r.qty_on_hand),
  };
}

/** Catalog fields the service supplies for create. */
export interface CreatePartRow {
  partCode: string;
  partName: string;
  uom?: string;
  itemId?: number;
  unitPrice?: number;
  reorderLevel?: number;
  isActive?: boolean;
}
/** Mutable catalog fields for update (part_code is immutable). */
export type PartFields = Partial<Pick<CreatePartRow, 'partName' | 'uom' | 'itemId' | 'unitPrice' | 'reorderLevel'>>;

const COL_OF: Record<string, string> = {
  partName: 'part_name', uom: 'uom', itemId: 'item_id',
  unitPrice: 'unit_price', reorderLevel: 'reorder_level',
};

/** Thrown by create when uq_spare_part_code (23505) is violated. */
export class DuplicatePartCodeError extends Error {}

export class SparesRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchStock(q: Queryable, spareId: number): Promise<SpareStock[]> {
    const res = await q.query(
      `SELECT ${S} FROM svc.spare_stock WHERE spare_id = $1 ORDER BY location`, [spareId]);
    return res.rows.map(mapStock);
  }

  /** Insert a spare into the catalog. company_id = ctx.companyId so the row passes
   *  RLS WITH CHECK. A duplicate (company_id, part_code) raises DuplicatePartCodeError. */
  async create(ctx: RequestContext, data: CreatePartRow): Promise<SparePart> {
    try {
      return await runInContext(this.pool, ctx, async (c) => {
        const res = await c.query(
          `INSERT INTO svc.spare_part
             (company_id, part_code, part_name, uom, item_id, unit_price, reorder_level,
              is_active, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING ${P}`,
          [ctx.companyId, data.partCode, data.partName, data.uom ?? null, data.itemId ?? null,
           data.unitPrice ?? 0, data.reorderLevel ?? 0, data.isActive ?? true, ctx.userId]);
        return mapPart(res.rows[0]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DuplicatePartCodeError();
      throw e;
    }
  }

  /** Header-only lookup (no stock). Used internally by the service for guard checks. */
  async findById(ctx: RequestContext, id: number): Promise<SparePart | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${P} FROM svc.spare_part WHERE spare_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? mapPart(res.rows[0]) : null;
    });
  }

  /** Full lookup: the part plus its per-location stock rows. */
  async findByIdWithStock(ctx: RequestContext, id: number): Promise<SparePart | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${P} FROM svc.spare_part WHERE spare_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapPart(res.rows[0]), stock: await this.fetchStock(c, id) };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<SparePartListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.active !== undefined) { params.push(q.active); where.push(`is_active = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(part_code ILIKE $${params.length} OR part_name ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM svc.spare_part WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${P} FROM svc.spare_part WHERE ${w}
          ORDER BY ${q.sort} ${dir}, spare_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapPart);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked field update. Returns null on a row-version mismatch. */
  async update(ctx: RequestContext, id: number, version: number, fields: PartFields): Promise<SparePart | null> {
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
        `UPDATE svc.spare_part
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE spare_id = $${pId} AND row_version = $${pVer} AND company_id = $${pCo} AND NOT is_deleted
          RETURNING ${P}`, params);
      return res.rowCount ? mapPart(res.rows[0]) : null;
    });
  }

  /** Flip is_active under optimistic lock. Returns null on a row-version mismatch. */
  async setActive(ctx: RequestContext, id: number, version: number, isActive: boolean): Promise<SparePart | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE svc.spare_part
            SET is_active = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE spare_id = $3 AND row_version = $4 AND company_id = $5 AND NOT is_deleted
          RETURNING ${P}`,
        [isActive, ctx.userId, id, version, ctx.companyId]);
      return res.rowCount ? mapPart(res.rows[0]) : null;
    });
  }

  /** Soft delete under optimistic lock. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE svc.spare_part
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE spare_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted`,
        [ctx.userId, id, version, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  /** Total on-hand across all locations for a spare (0 if it has no stock rows). */
  async totalOnHand(ctx: RequestContext, spareId: number): Promise<number> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT COALESCE(SUM(qty_on_hand), 0)::text AS t FROM svc.spare_stock WHERE spare_id = $1`,
        [spareId]);
      return Number(res.rows[0].t);
    });
  }

  /** The per-location stock rows for a spare. */
  async stockByPart(ctx: RequestContext, spareId: number): Promise<SpareStock[]> {
    return runRead(this.pool, ctx, async (c) => this.fetchStock(c, spareId));
  }

  /**
   * Upsert the (spare, location) stock row, adding `delta` to qty_on_hand atomically.
   * Re-checks the parent spare is live + in-tenant inside the transaction (the child
   * carries no company_id, so this is the tenant gate). Returns the refreshed stock
   * row, or null if the parent was not found in this tenant. The caller (service)
   * has already rejected a delta that would drive the balance negative.
   */
  async adjustStock(ctx: RequestContext, spareId: number, location: string, delta: number): Promise<SpareStock | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const parent = await c.query(
        `SELECT 1 FROM svc.spare_part WHERE spare_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [spareId, ctx.companyId]);
      if (!parent.rowCount) return null;
      const res = await c.query(
        `INSERT INTO svc.spare_stock (spare_id, location, qty_on_hand)
         VALUES ($1, $2, $3)
         ON CONFLICT (spare_id, location)
           DO UPDATE SET qty_on_hand = svc.spare_stock.qty_on_hand + EXCLUDED.qty_on_hand
         RETURNING ${S}`,
        [spareId, location, delta]);
      return mapStock(res.rows[0]);
    });
  }

  /**
   * Low-stock read: live spares whose total on-hand across all locations is at or
   * below their reorder_level (replenishment candidates). reorder_level 0 means "do
   * not flag" — excluded so a part with no reorder policy is not perpetually low.
   */
  async lowStock(ctx: RequestContext): Promise<LowStockRow[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT sp.spare_id, sp.part_code, sp.part_name, sp.uom, sp.reorder_level,
                COALESCE(SUM(ss.qty_on_hand), 0) AS total_on_hand
           FROM svc.spare_part sp
           LEFT JOIN svc.spare_stock ss ON ss.spare_id = sp.spare_id
          WHERE sp.company_id = $1 AND NOT sp.is_deleted AND sp.is_active AND sp.reorder_level > 0
          GROUP BY sp.spare_id, sp.part_code, sp.part_name, sp.uom, sp.reorder_level
         HAVING COALESCE(SUM(ss.qty_on_hand), 0) <= sp.reorder_level
          ORDER BY sp.part_code`,
        [ctx.companyId]);
      return res.rows.map((r) => ({
        spareId: Number(r.spare_id),
        partCode: r.part_code,
        partName: r.part_name,
        uom: (r.uom as string) ?? null,
        reorderLevel: Number(r.reorder_level),
        totalOnHand: Number(r.total_on_hand),
      }));
    });
  }
}
