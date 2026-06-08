import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { OutboxEventInput, emitOutbox } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { Asset, WorkOrder, AssetListResult, WorkOrderListResult } from './maintenance.types';
import { AssetStatus, WoStatus, DOC_TYPE } from './maintenance.constants';
import { AssetListQueryDto, WoListQueryDto } from './maintenance.dto';

/** Columns of maint.asset (created in migration 033). */
const A = `asset_id, company_id, asset_code, asset_name, asset_type, location, status,
  created_at, created_by, updated_at, row_version`;

/** Columns of maint.work_order. */
const W = `mwo_id, company_id, bu_id, mwo_no, asset_id, wo_type, scheduled_date,
  completed_date, status, notes, created_at, created_by, updated_at, row_version`;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function mapAsset(r: QueryResultRow): Asset {
  return {
    assetId: Number(r.asset_id),
    companyId: Number(r.company_id),
    assetCode: r.asset_code as string,
    assetName: r.asset_name as string,
    assetType: (r.asset_type as Asset['assetType']) ?? null,
    location: (r.location as string) ?? null,
    status: r.status as AssetStatus,
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}

function mapWo(r: QueryResultRow): WorkOrder {
  return {
    mwoId: Number(r.mwo_id),
    companyId: Number(r.company_id),
    buId: num(r.bu_id),
    mwoNo: r.mwo_no as string,
    assetId: Number(r.asset_id),
    woType: r.wo_type as WorkOrder['woType'],
    scheduledDate: (r.scheduled_date as string) ?? null,
    completedDate: (r.completed_date as string) ?? null,
    status: r.status as WoStatus,
    notes: (r.notes as string) ?? null,
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}

/** Asset fields the service supplies on create. */
export interface CreateAssetRow {
  assetCode: string; assetName: string; assetType?: string; location?: string;
}
/** Editable asset fields (asset_code is immutable). */
export interface AssetFields {
  assetName?: string; assetType?: string; location?: string;
}
const ASSET_COL_OF: Record<string, string> = {
  assetName: 'asset_name', assetType: 'asset_type', location: 'location',
};

/** Work-order fields the service supplies on create (mwo_no is DB-allocated). */
export interface CreateWoRow {
  assetId: number; woType: string; scheduledDate?: string; notes?: string;
}
/** Editable work-order fields. */
export interface WoFields {
  woType?: string; scheduledDate?: string; notes?: string;
}
const WO_COL_OF: Record<string, string> = {
  woType: 'wo_type', scheduledDate: 'scheduled_date', notes: 'notes',
};

export class MaintenanceRepository {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------
  // Asset register
  // -------------------------------------------------------------------

  async createAsset(ctx: RequestContext, data: CreateAssetRow): Promise<Asset> {
    return runInContext(this.pool, ctx, async (c: Queryable) => {
      const res = await c.query(
        `INSERT INTO maint.asset
           (company_id, asset_code, asset_name, asset_type, location, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)
         RETURNING ${A}`,
        [ctx.companyId, data.assetCode, data.assetName,
         data.assetType ?? null, data.location ?? null, ctx.userId]);
      return mapAsset(res.rows[0]);
    });
  }

  async findAssetById(ctx: RequestContext, id: number): Promise<Asset | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${A} FROM maint.asset WHERE asset_id=$1 AND company_id=$2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? mapAsset(res.rows[0]) : null;
    });
  }

  async listAssets(ctx: RequestContext, q: AssetListQueryDto): Promise<AssetListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.type) { params.push(q.type); where.push(`asset_type = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(asset_code ILIKE $${params.length} OR asset_name ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM maint.asset WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${A} FROM maint.asset WHERE ${w}
          ORDER BY ${q.sort} ${dir}, asset_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapAsset);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  async updateAsset(ctx: RequestContext, id: number, version: number, fields: AssetFields): Promise<Asset | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      params.push(v); set.push(`${ASSET_COL_OF[k]} = $${params.length}`);
    }
    if (set.length === 0) return this.findAssetById(ctx, id);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(ctx.userId); const pUser = params.length;
      params.push(id); const pId = params.length;
      params.push(version); const pVer = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      const res = await c.query(
        `UPDATE maint.asset
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE asset_id = $${pId} AND row_version = $${pVer} AND company_id = $${pCo} AND NOT is_deleted
          RETURNING ${A}`, params);
      return res.rowCount ? mapAsset(res.rows[0]) : null;
    });
  }

  /** Optimistic-locked asset status change. Optionally runs inside a caller-supplied
   *  transaction client (used by the work-order lifecycle so the asset + WO change
   *  commit atomically). Returns null on a row-version mismatch. */
  async setAssetStatus(
    ctx: RequestContext, id: number, version: number, status: AssetStatus, client?: Queryable,
  ): Promise<Asset | null> {
    const run = async (c: Queryable) => {
      const res = await c.query(
        `UPDATE maint.asset
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE asset_id = $3 AND row_version = $4 AND company_id = $5 AND NOT is_deleted
          RETURNING ${A}`,
        [status, ctx.userId, id, version, ctx.companyId]);
      return res.rowCount ? mapAsset(res.rows[0]) : null;
    };
    return client ? run(client) : runInContext(this.pool, ctx, run);
  }

  /** Force an asset's status from the work-order lifecycle (no row-version check —
   *  the WO holds the lock). Runs inside the caller's transaction. */
  private async forceAssetStatus(c: Queryable, ctx: RequestContext, assetId: number, status: AssetStatus): Promise<void> {
    await c.query(
      `UPDATE maint.asset
          SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
        WHERE asset_id = $3 AND company_id = $4 AND NOT is_deleted`,
      [status, ctx.userId, assetId, ctx.companyId]);
  }

  async softDeleteAsset(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE maint.asset
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE asset_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted`,
        [ctx.userId, id, version, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  // -------------------------------------------------------------------
  // Maintenance work order
  // -------------------------------------------------------------------

  /** Insert a work order (OPEN), allocating its MWO number in the same transaction.
   *  company_id = ctx.companyId so the row passes RLS WITH CHECK. */
  async createWo(ctx: RequestContext, data: CreateWoRow): Promise<WorkOrder> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO maint.work_order
           (company_id, bu_id, mwo_no, asset_id, wo_type, scheduled_date, status, notes, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5::date,'OPEN',$6,$7)
         RETURNING ${W}`,
        [ctx.companyId, ctx.buId, data.assetId, data.woType,
         data.scheduledDate ?? null, data.notes ?? null, ctx.userId]);
      return mapWo(res.rows[0]);
    });
  }

  async findWoById(ctx: RequestContext, id: number): Promise<WorkOrder | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${W} FROM maint.work_order WHERE mwo_id=$1 AND company_id=$2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? mapWo(res.rows[0]) : null;
    });
  }

  async listWo(ctx: RequestContext, q: WoListQueryDto): Promise<WorkOrderListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.type) { params.push(q.type); where.push(`wo_type = $${params.length}`); }
    if (q.assetId) { params.push(q.assetId); where.push(`asset_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`mwo_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM maint.work_order WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${W} FROM maint.work_order WHERE ${w}
          ORDER BY ${q.sort} ${dir}, mwo_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapWo);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  async updateWo(ctx: RequestContext, id: number, version: number, fields: WoFields): Promise<WorkOrder | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      const col = WO_COL_OF[k];
      params.push(v);
      set.push(col === 'scheduled_date' ? `${col} = $${params.length}::date` : `${col} = $${params.length}`);
    }
    if (set.length === 0) return this.findWoById(ctx, id);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(ctx.userId); const pUser = params.length;
      params.push(id); const pId = params.length;
      params.push(version); const pVer = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      const res = await c.query(
        `UPDATE maint.work_order
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE mwo_id = $${pId} AND row_version = $${pVer} AND company_id = $${pCo} AND NOT is_deleted
          RETURNING ${W}`, params);
      return res.rowCount ? mapWo(res.rows[0]) : null;
    });
  }

  /**
   * Lifecycle status change on a work order under optimistic lock. Optionally, in the
   * SAME transaction: drive the asset's status (e.g. UNDER_MAINTENANCE on start,
   * ACTIVE on complete), stamp completed_date, and emit an outbox event — so the WO
   * state change, the asset change and the event all commit atomically. Returns null
   * on a row-version mismatch.
   */
  async setWoStatus(
    ctx: RequestContext, id: number, version: number, status: WoStatus,
    opts: { assetId?: number; assetStatus?: AssetStatus; setCompletedDate?: boolean; event?: OutboxEventInput } = {},
  ): Promise<WorkOrder | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const completed = opts.setCompletedDate ? ', completed_date = CURRENT_DATE' : '';
      const res = await c.query(
        `UPDATE maint.work_order
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1${completed}
          WHERE mwo_id = $3 AND row_version = $4 AND company_id = $5 AND NOT is_deleted
          RETURNING ${W}`,
        [status, ctx.userId, id, version, ctx.companyId]);
      if (!res.rowCount) return null;
      if (opts.assetId != null && opts.assetStatus) {
        await this.forceAssetStatus(c, ctx, opts.assetId, opts.assetStatus);
      }
      if (opts.event) await emitOutbox(c, opts.event);
      return mapWo(res.rows[0]);
    });
  }

  async softDeleteWo(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE maint.work_order
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE mwo_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted`,
        [ctx.userId, id, version, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
