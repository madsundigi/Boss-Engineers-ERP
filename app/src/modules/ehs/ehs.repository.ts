import { Pool } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { OutboxEventInput, emitOutbox } from '../../outbox/outbox';
import { Incident, IncidentListResult } from './ehs.types';
import { IncidentStatus, DOC_TYPE } from './ehs.constants';
import { ListQueryDto } from './ehs.dto';

/** Columns of ehs.incident (created in migration 035). */
const COLS = `incident_id, company_id, bu_id, incident_no, incident_date, incident_type,
  severity, location, project_id, description, corrective_action, status, reported_by,
  closed_at, created_at, created_by, updated_at, row_version`;

type Row = Record<string, unknown>;
function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}
function isoN(v: unknown): string | null {
  return v == null ? null : (v instanceof Date ? v.toISOString() : (v as string));
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function map(r: Row): Incident {
  return {
    incidentId: Number(r.incident_id),
    companyId: Number(r.company_id),
    buId: num(r.bu_id),
    incidentNo: r.incident_no as string,
    incidentDate: r.incident_date as string,
    incidentType: r.incident_type as Incident['incidentType'],
    severity: r.severity as Incident['severity'],
    location: (r.location as string) ?? null,
    projectId: num(r.project_id),
    description: r.description as string,
    correctiveAction: (r.corrective_action as string) ?? null,
    status: r.status as IncidentStatus,
    reportedBy: num(r.reported_by),
    closedAt: isoN(r.closed_at),
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}

/** Incident fields the service supplies on create (incident_no is DB-allocated). */
export interface CreateIncidentRow {
  incidentDate?: string; incidentType: string; severity?: string; location?: string;
  projectId?: number; description: string; correctiveAction?: string;
}
/** Editable incident fields. */
export interface IncidentFields {
  incidentDate?: string; incidentType?: string; severity?: string; location?: string;
  projectId?: number; description?: string; correctiveAction?: string;
}

const COL_OF: Record<string, string> = {
  incidentDate: 'incident_date', incidentType: 'incident_type', severity: 'severity',
  location: 'location', projectId: 'project_id', description: 'description',
  correctiveAction: 'corrective_action',
};

export class EhsRepository {
  constructor(private readonly pool: Pool) {}

  /** Insert an incident (REPORTED), allocating its INCIDENT number in the same
   *  transaction. company_id = ctx.companyId so the row passes RLS WITH CHECK;
   *  reported_by = ctx.userId. */
  async create(ctx: RequestContext, data: CreateIncidentRow): Promise<Incident> {
    return runInContext(this.pool, ctx, async (c: Queryable) => {
      const res = await c.query(
        `INSERT INTO ehs.incident
           (company_id, bu_id, incident_no, incident_date, incident_type, severity,
            location, project_id, description, corrective_action, status, reported_by, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 COALESCE($3::date, CURRENT_DATE), $4, COALESCE($5,'LOW'),
                 $6,$7,$8,$9,'REPORTED',$10,$10)
         RETURNING ${COLS}`,
        [ctx.companyId, ctx.buId, data.incidentDate ?? null, data.incidentType,
         data.severity ?? null, data.location ?? null, data.projectId ?? null,
         data.description, data.correctiveAction ?? null, ctx.userId]);
      return map(res.rows[0]);
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Incident | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${COLS} FROM ehs.incident WHERE incident_id=$1 AND company_id=$2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? map(res.rows[0]) : null;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<IncidentListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.type) { params.push(q.type); where.push(`incident_type = $${params.length}`); }
    if (q.severity) { params.push(q.severity); where.push(`severity = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(incident_no ILIKE $${params.length} OR location ILIKE $${params.length})`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';  // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM ehs.incident WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${COLS} FROM ehs.incident WHERE ${w}
          ORDER BY ${q.sort} ${dir}, incident_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(map);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  async update(ctx: RequestContext, id: number, version: number, fields: IncidentFields): Promise<Incident | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      const col = COL_OF[k];
      params.push(v);
      set.push(col === 'incident_date' ? `${col} = $${params.length}::date` : `${col} = $${params.length}`);
    }
    if (set.length === 0) return this.findById(ctx, id);
    return runInContext(this.pool, ctx, async (c) => {
      params.push(ctx.userId); const pUser = params.length;
      params.push(id); const pId = params.length;
      params.push(version); const pVer = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      const res = await c.query(
        `UPDATE ehs.incident
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE incident_id = $${pId} AND row_version = $${pVer} AND company_id = $${pCo} AND NOT is_deleted
          RETURNING ${COLS}`, params);
      return res.rowCount ? map(res.rows[0]) : null;
    });
  }

  /**
   * Lifecycle status change under optimistic lock. Optionally, in the SAME
   * transaction: stamp closed_at (on close) and emit an outbox event — so the status
   * change and the event commit atomically. Returns null on a row-version mismatch.
   */
  async setStatus(
    ctx: RequestContext, id: number, version: number, status: IncidentStatus,
    opts: { setClosedAt?: boolean; event?: OutboxEventInput } = {},
  ): Promise<Incident | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const closed = opts.setClosedAt ? ', closed_at = now()' : '';
      const res = await c.query(
        `UPDATE ehs.incident
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1${closed}
          WHERE incident_id = $3 AND row_version = $4 AND company_id = $5 AND NOT is_deleted
          RETURNING ${COLS}`,
        [status, ctx.userId, id, version, ctx.companyId]);
      if (!res.rowCount) return null;
      if (opts.event) await emitOutbox(c, opts.event);
      return map(res.rows[0]);
    });
  }

  async softDelete(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE ehs.incident
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE incident_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted`,
        [ctx.userId, id, version, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
