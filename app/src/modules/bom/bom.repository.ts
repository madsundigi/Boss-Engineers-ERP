import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { BomHeader, BomLine, BomListResult } from './bom.types';
import { ListQueryDto } from './bom.dto';
import { DOC_TYPE, BomStatus } from './bom.constants';

/** Header columns of mdm.bom_header (bu_id added in migration 018). */
const H = `bom_id, bom_no, company_id, bu_id, parent_item_id, bom_type, revision,
  project_id, status, effective_from, created_at, created_by, updated_at, row_version`;

type Header = Omit<BomHeader, 'lines'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    bomId: Number(r.bom_id),
    bomNo: r.bom_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    parentItemId: Number(r.parent_item_id),
    bomType: r.bom_type,
    revision: r.revision,
    projectId: r.project_id == null ? null : Number(r.project_id),
    status: r.status,
    effectiveFrom: r.effective_from,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapLine(r: QueryResultRow): BomLine {
  return {
    bomLineId: Number(r.bom_line_id),
    componentItemId: Number(r.component_item_id),
    qtyPer: Number(r.qty_per),
    uomId: Number(r.uom_id),
    scrapPct: Number(r.scrap_pct),
    isCritical: r.is_critical,
  };
}

export interface BomHeaderInput {
  parentItemId: number;
  bomType: string;
  revision: string;
  projectId?: number;
  effectiveFrom?: string;
}

export class BomRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchLines(q: Queryable, id: number): Promise<BomLine[]> {
    const res = await q.query(
      `SELECT bom_line_id, component_item_id, qty_per, uom_id, scrap_pct, is_critical
         FROM mdm.bom_line WHERE bom_id = $1 ORDER BY bom_line_id`, [id]);
    return res.rows.map(mapLine);
  }
  private async insertLines(q: Queryable, id: number, lines: BomLine[]): Promise<void> {
    for (const l of lines) {
      await q.query(
        `INSERT INTO mdm.bom_line
           (bom_id, component_item_id, qty_per, uom_id, scrap_pct, is_critical)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, l.componentItemId, l.qtyPer, l.uomId, l.scrapPct, l.isCritical]);
    }
  }

  /** Insert, allocating the gapless BOM number inside the same transaction. */
  async create(ctx: RequestContext, h: BomHeaderInput, lines: BomLine[]): Promise<BomHeader> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO mdm.bom_header
           (company_id, bu_id, bom_no, parent_item_id, bom_type, revision,
            project_id, status, effective_from, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6, 'DRAFT', $7, $8)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.parentItemId, h.bomType, h.revision,
          h.projectId ?? null, h.effectiveFrom ?? null, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      await this.insertLines(c, header.bomId, lines);
      return { ...header, lines: await this.fetchLines(c, header.bomId) };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<BomHeader | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM mdm.bom_header
          WHERE bom_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), lines: await this.fetchLines(c, id) };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<BomListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.bomType) { params.push(q.bomType); where.push(`bom_type = $${params.length}`); }
    if (q.parentItemId) { params.push(q.parentItemId); where.push(`parent_item_id = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`bom_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM mdm.bom_header WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM mdm.bom_header WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked header update + full line replacement. Null on version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number,
    fields: Partial<BomHeaderInput>, lines?: BomLine[],
  ): Promise<BomHeader | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.bomType !== undefined) add('bom_type', fields.bomType);
    if (fields.revision !== undefined) add('revision', fields.revision);
    if (fields.projectId !== undefined) add('project_id', fields.projectId);
    if (fields.effectiveFrom !== undefined) add('effective_from', fields.effectiveFrom);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE mdm.bom_header
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE bom_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      const header = mapHeader(res.rows[0]);
      if (lines) {
        await c.query(`DELETE FROM mdm.bom_line WHERE bom_id = $1`, [id]);
        await this.insertLines(c, id, lines);
      }
      return { ...header, lines: await this.fetchLines(c, id) };
    });
  }

  /**
   * Lifecycle status change with an optional outbox event (e.g. 'bom.released'
   * on release) emitted atomically with the state change (transactional outbox).
   * Returns null on a row-version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: BomStatus,
    event?: OutboxEventInput,
  ): Promise<BomHeader | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE mdm.bom_header
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE bom_id = $3 AND company_id = $4 AND row_version = $5 AND NOT is_deleted
        RETURNING ${H}`,
        [status, ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;
      if (event) await emitOutbox(c, event);
      return { ...mapHeader(res.rows[0]), lines: await this.fetchLines(c, id) };
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE mdm.bom_header
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE bom_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
