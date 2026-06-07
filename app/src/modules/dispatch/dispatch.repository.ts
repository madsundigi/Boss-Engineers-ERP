import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { Dispatch, DispatchSerial, PackingLine, DispatchListResult } from './dispatch.types';
import { ListQueryDto } from './dispatch.dto';
import { DOC_TYPE, DispatchStatus } from './dispatch.constants';

/** Header columns of log.dispatch (bu_id + gate columns added in migration 013). */
const H = `dispatch_id, dispatch_no, company_id, bu_id, project_id, customer_id, fat_id,
  dispatch_date, ship_to_address_id, transporter, lr_no, eway_bill_no, status,
  quality_cleared_by, quality_cleared_at, commercial_cleared_by, commercial_cleared_at,
  created_at, created_by, updated_at, row_version`;

type Header = Omit<Dispatch, 'serials' | 'packingLines'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    dispatchId: Number(r.dispatch_id),
    dispatchNo: r.dispatch_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    projectId: Number(r.project_id),
    customerId: Number(r.customer_id),
    fatId: r.fat_id == null ? null : Number(r.fat_id),
    dispatchDate: r.dispatch_date,
    shipToAddressId: r.ship_to_address_id == null ? null : Number(r.ship_to_address_id),
    transporter: r.transporter,
    lrNo: r.lr_no,
    ewayBillNo: r.eway_bill_no,
    status: r.status,
    qualityClearedBy: r.quality_cleared_by == null ? null : Number(r.quality_cleared_by),
    qualityClearedAt: r.quality_cleared_at,
    commercialClearedBy: r.commercial_cleared_by == null ? null : Number(r.commercial_cleared_by),
    commercialClearedAt: r.commercial_cleared_at,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapSerial(r: QueryResultRow): DispatchSerial {
  return {
    dispatchLineId: Number(r.dispatch_line_id),
    itemId: Number(r.item_id),
    serialId: r.serial_id == null ? null : Number(r.serial_id),
    qty: Number(r.qty),
  };
}
function mapPacking(r: QueryResultRow): PackingLine {
  return {
    packingId: Number(r.packing_id),
    packageNo: r.package_no,
    grossWeight: r.gross_weight == null ? null : Number(r.gross_weight),
    dimensions: r.dimensions,
  };
}

export interface DispatchHeaderInput {
  projectId: number;
  customerId: number;
  fatId?: number;
  shipToAddressId?: number;
  dispatchDate?: string;
  transporter?: string;
  lrNo?: string;
  ewayBillNo?: string;
}
/** Partial header patch carried alongside a status / gate change. */
export type StatusPatch = Partial<Record<
  'quality_cleared_by' | 'quality_cleared_at' | 'commercial_cleared_by' | 'commercial_cleared_at',
  unknown
>>;

export class DispatchRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchSerials(q: Queryable, id: number): Promise<DispatchSerial[]> {
    const res = await q.query(
      `SELECT dispatch_line_id, item_id, serial_id, qty
         FROM log.dispatch_line WHERE dispatch_id = $1 ORDER BY dispatch_line_id`, [id]);
    return res.rows.map(mapSerial);
  }
  private async fetchPacking(q: Queryable, id: number): Promise<PackingLine[]> {
    const res = await q.query(
      `SELECT packing_id, package_no, gross_weight, dimensions
         FROM log.packing_list WHERE dispatch_id = $1 ORDER BY packing_id`, [id]);
    return res.rows.map(mapPacking);
  }
  private async insertSerials(q: Queryable, id: number, serials: DispatchSerial[]): Promise<void> {
    for (const s of serials) {
      await q.query(
        `INSERT INTO log.dispatch_line (dispatch_id, item_id, serial_id, qty)
         VALUES ($1,$2,$3,$4)`,
        [id, s.itemId, s.serialId ?? null, s.qty]);
    }
  }
  private async insertPacking(q: Queryable, id: number, lines: PackingLine[]): Promise<void> {
    for (const p of lines) {
      await q.query(
        `INSERT INTO log.packing_list (dispatch_id, package_no, gross_weight, dimensions)
         VALUES ($1,$2,$3,$4)`,
        [id, p.packageNo, p.grossWeight ?? null, p.dimensions ?? null]);
    }
  }

  /** Insert, allocating the gapless dispatch number inside the same transaction. */
  async create(
    ctx: RequestContext, h: DispatchHeaderInput, serials: DispatchSerial[], packing: PackingLine[],
  ): Promise<Dispatch> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO log.dispatch
           (company_id, bu_id, dispatch_no, project_id, customer_id, fat_id,
            dispatch_date, ship_to_address_id, transporter, lr_no, eway_bill_no, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5, COALESCE($6::date, current_date), $7,$8,$9,$10, 'DRAFT', $11)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.projectId, h.customerId, h.fatId ?? null,
          h.dispatchDate ?? null, h.shipToAddressId ?? null, h.transporter ?? null,
          h.lrNo ?? null, h.ewayBillNo ?? null, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      await this.insertSerials(c, header.dispatchId, serials);
      await this.insertPacking(c, header.dispatchId, packing);
      return {
        ...header,
        serials: await this.fetchSerials(c, header.dispatchId),
        packingLines: await this.fetchPacking(c, header.dispatchId),
      };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Dispatch | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM log.dispatch
          WHERE dispatch_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return {
        ...mapHeader(res.rows[0]),
        serials: await this.fetchSerials(c, id),
        packingLines: await this.fetchPacking(c, id),
      };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<DispatchListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`dispatch_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM log.dispatch WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM log.dispatch WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked header update + child replacement. Null on version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number,
    fields: Partial<DispatchHeaderInput>, serials?: DispatchSerial[], packing?: PackingLine[],
  ): Promise<Dispatch | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.shipToAddressId !== undefined) add('ship_to_address_id', fields.shipToAddressId);
    if (fields.dispatchDate !== undefined) add('dispatch_date', fields.dispatchDate);
    if (fields.transporter !== undefined) add('transporter', fields.transporter);
    if (fields.lrNo !== undefined) add('lr_no', fields.lrNo);
    if (fields.ewayBillNo !== undefined) add('eway_bill_no', fields.ewayBillNo);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE log.dispatch
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE dispatch_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      const header = mapHeader(res.rows[0]);
      if (serials) {
        await c.query(`DELETE FROM log.dispatch_line WHERE dispatch_id = $1`, [id]);
        await this.insertSerials(c, id, serials);
      }
      if (packing) {
        await c.query(`DELETE FROM log.packing_list WHERE dispatch_id = $1`, [id]);
        await this.insertPacking(c, id, packing);
      }
      return {
        ...header,
        serials: await this.fetchSerials(c, id),
        packingLines: await this.fetchPacking(c, id),
      };
    });
  }

  /**
   * Lifecycle status change with an optional gate/header patch and an optional
   * outbox event (e.g. 'dispatch.released' on release) emitted atomically with
   * the state change. Returns null on a row-version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: DispatchStatus,
    patch: StatusPatch = {}, event?: OutboxEventInput,
  ): Promise<Dispatch | null> {
    const set: string[] = ['status = $1'];
    const params: unknown[] = [status];
    for (const [col, val] of Object.entries(patch)) { params.push(val); set.push(`${col} = $${params.length}`); }
    params.push(ctx.userId); set.push(`updated_by = $${params.length}`);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE log.dispatch SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE dispatch_id = $${pId} AND company_id = $${pCo} AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      // Atomic with the state change: record the domain event (transactional outbox).
      if (event) await emitOutbox(c, event);
      return {
        ...mapHeader(res.rows[0]),
        serials: await this.fetchSerials(c, id),
        packingLines: await this.fetchPacking(c, id),
      };
    });
  }

  /**
   * Open a single clearance gate (quality or commercial) under optimistic lock.
   * Only stamps the gate if it is not already set, so re-clearing is a no-op on
   * the timestamp. Returns null on a row-version mismatch.
   */
  async setGate(
    ctx: RequestContext, id: number, expectedVersion: number, patch: StatusPatch,
  ): Promise<Dispatch | null> {
    return this.updateStatus(ctx, id, expectedVersion, 'DRAFT', patch);
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE log.dispatch
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE dispatch_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
