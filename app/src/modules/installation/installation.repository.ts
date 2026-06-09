import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { Installation, PunchItem, InstallationListResult } from './installation.types';
import { ListQueryDto } from './installation.dto';
import { DOC_TYPE, InstallationStatus } from './installation.constants';

/** Header columns of svc.installation (bu_id added in migration 014; the rest exist in db/04). */
const H = `install_id, install_no, company_id, bu_id, project_id, dispatch_id,
  site_address, site_engineer_id, progress_pct, planned_date, actual_date, sat_result,
  acceptance_cert_no, accepted_date,
  status, created_at, created_by, updated_at, row_version`;

type Header = Omit<Installation, 'punchItems'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    installId: Number(r.install_id),
    installNo: r.install_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    projectId: Number(r.project_id),
    dispatchId: r.dispatch_id == null ? null : Number(r.dispatch_id),
    siteAddress: r.site_address,
    siteEngineerId: r.site_engineer_id == null ? null : Number(r.site_engineer_id),
    progressPct: r.progress_pct == null ? null : Number(r.progress_pct),
    plannedDate: r.planned_date,
    actualDate: r.actual_date,
    satResult: r.sat_result,
    acceptanceCertNo: r.acceptance_cert_no,
    acceptedDate: r.accepted_date,
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapPunch(r: QueryResultRow): PunchItem {
  return {
    punchId: Number(r.punch_id),
    description: r.description,
    severity: r.severity,
    status: r.status,
    closedDate: r.closed_date,
  };
}

export interface InstallationHeaderInput {
  projectId: number;
  dispatchId?: number;
  siteAddress?: string;
  siteEngineerId?: number;
  progressPct?: number;
  plannedDate?: string;
}
/** Partial header patch carried alongside a status change (SAT / acceptance stamps). */
export type StatusPatch = Partial<Record<
  'sat_result' | 'actual_date' | 'acceptance_cert_no' | 'accepted_date',
  unknown
>>;

export class InstallationRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchPunch(q: Queryable, id: number): Promise<PunchItem[]> {
    const res = await q.query(
      `SELECT punch_id, description, severity, status, closed_date
         FROM qms.punch_item WHERE install_id = $1 ORDER BY punch_id`, [id]);
    return res.rows.map(mapPunch);
  }
  private async insertPunch(q: Queryable, id: number, items: PunchItem[]): Promise<void> {
    for (const p of items) {
      await q.query(
        `INSERT INTO qms.punch_item (install_id, description, severity, status, closed_date)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, p.description, p.severity ?? null, p.status, p.closedDate ?? null]);
    }
  }

  /** Insert, allocating the gapless installation number inside the same transaction. */
  async create(
    ctx: RequestContext, h: InstallationHeaderInput, punch: PunchItem[],
  ): Promise<Installation> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO svc.installation
           (company_id, bu_id, install_no, project_id, dispatch_id,
            site_address, site_engineer_id, progress_pct, planned_date, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,$7,$8, 'PLANNED', $9)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.projectId, h.dispatchId ?? null,
          h.siteAddress ?? null, h.siteEngineerId ?? null, h.progressPct ?? null,
          h.plannedDate ?? null, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      await this.insertPunch(c, header.installId, punch);
      return { ...header, punchItems: await this.fetchPunch(c, header.installId) };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Installation | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM svc.installation
          WHERE install_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), punchItems: await this.fetchPunch(c, id) };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<InstallationListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`install_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM svc.installation WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM svc.installation WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked header update + punch-list replacement. Null on version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number,
    fields: Partial<InstallationHeaderInput>, punch?: PunchItem[],
  ): Promise<Installation | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.dispatchId !== undefined) add('dispatch_id', fields.dispatchId);
    if (fields.siteAddress !== undefined) add('site_address', fields.siteAddress);
    if (fields.siteEngineerId !== undefined) add('site_engineer_id', fields.siteEngineerId);
    if (fields.progressPct !== undefined) add('progress_pct', fields.progressPct);
    if (fields.plannedDate !== undefined) add('planned_date', fields.plannedDate);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE svc.installation
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE install_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      const header = mapHeader(res.rows[0]);
      if (punch) {
        await c.query(`DELETE FROM qms.punch_item WHERE install_id = $1`, [id]);
        await this.insertPunch(c, id, punch);
      }
      return { ...header, punchItems: await this.fetchPunch(c, id) };
    });
  }

  /**
   * Lifecycle status change with an optional header patch (SAT / acceptance
   * stamps) and an optional outbox event (e.g. 'installation.accepted' on
   * acceptance) emitted atomically with the state change (transactional outbox).
   * Returns null on a row-version mismatch.
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: InstallationStatus,
    patch: StatusPatch = {}, event?: OutboxEventInput,
  ): Promise<Installation | null> {
    const set: string[] = ['status = $1'];
    const params: unknown[] = [status];
    for (const [col, val] of Object.entries(patch)) { params.push(val); set.push(`${col} = $${params.length}`); }
    params.push(ctx.userId); set.push(`updated_by = $${params.length}`);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE svc.installation SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE install_id = $${pId} AND company_id = $${pCo} AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      if (event) await emitOutbox(c, event);
      return { ...mapHeader(res.rows[0]), punchItems: await this.fetchPunch(c, id) };
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE svc.installation
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE install_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
