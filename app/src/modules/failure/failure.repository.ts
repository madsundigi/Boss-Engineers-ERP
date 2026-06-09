import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { Ncr, Rca, Capa, CapaAction, NcrListResult, ParetoCount } from './failure.types';
import { ListQueryDto, ParetoQueryDto } from './failure.dto';
import { DOC_TYPE, NcrStatus, RcaMethod, CapaType, CapaStatus } from './failure.constants';

/** Header columns of qms.ncr (bu_id added in migration 016; the rest exist in db/04). */
const H = `ncr_id, ncr_no, company_id, bu_id, source, source_doc_id, item_id, project_id,
  failure_mode_id, severity, raised_date, status,
  created_at, created_by, updated_at, row_version`;

type Header = Omit<Ncr, 'rca' | 'capa'>;

function mapHeader(r: QueryResultRow): Header {
  return {
    ncrId: Number(r.ncr_id),
    ncrNo: r.ncr_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    source: r.source,
    sourceDocId: r.source_doc_id == null ? null : Number(r.source_doc_id),
    itemId: r.item_id == null ? null : Number(r.item_id),
    projectId: r.project_id == null ? null : Number(r.project_id),
    failureModeId: r.failure_mode_id == null ? null : Number(r.failure_mode_id),
    severity: r.severity,
    raisedDate: r.raised_date,
    status: r.status,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}
function mapRca(r: QueryResultRow): Rca {
  return {
    rcaId: Number(r.rca_id),
    method: r.method,
    rootCause: r.root_cause,
    analysis: r.analysis ?? null,
    analysedBy: r.analysed_by == null ? null : Number(r.analysed_by),
    analysedAt: r.analysed_at,
  };
}
function mapCapaAction(r: QueryResultRow): CapaAction {
  return {
    capaActionId: Number(r.capa_action_id),
    capaId: Number(r.capa_id),
    description: r.description,
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    dueDate: r.due_date,
    doneDate: r.done_date,
    status: r.status,
  };
}
function mapCapa(r: QueryResultRow): Omit<Capa, 'actions'> {
  return {
    capaId: Number(r.capa_id),
    capaType: r.capa_type,
    action: r.action,
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    dueDate: r.due_date,
    effectivenessCheck: r.effectiveness_check,
    status: r.status,
  };
}

export interface NcrHeaderInput {
  source: string;
  sourceDocId?: number;
  itemId?: number;
  projectId?: number;
  failureModeId?: number;
  severity?: string;
  raisedDate?: string;
}
export interface RcaInput {
  method: RcaMethod;
  rootCause?: string;
  analysis?: Record<string, unknown>;
}
export interface CapaInput {
  capaType: CapaType;
  action: string;
  ownerId?: number;
  dueDate?: string;
  effectivenessCheck?: string;
}
export interface CapaActionInput {
  description: string;
  ownerId?: number;
  dueDate?: string;
}

export class FailureRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchRca(q: Queryable, id: number): Promise<Rca[]> {
    const res = await q.query(
      `SELECT rca_id, method, root_cause, analysis, analysed_by, analysed_at
         FROM qms.rca WHERE ncr_id = $1 ORDER BY rca_id`, [id]);
    return res.rows.map(mapRca);
  }
  private async fetchCapa(q: Queryable, id: number): Promise<Capa[]> {
    const capaRes = await q.query(
      `SELECT capa_id, capa_type, action, owner_id, due_date, effectiveness_check, status
         FROM qms.capa WHERE ncr_id = $1 ORDER BY capa_id`, [id]);
    const capas = capaRes.rows.map(mapCapa);
    if (capas.length === 0) return [];
    const ids = capas.map((c) => c.capaId);
    const actRes = await q.query(
      `SELECT capa_action_id, capa_id, description, owner_id, due_date, done_date, status
         FROM qms.capa_action WHERE capa_id = ANY($1::bigint[]) ORDER BY capa_action_id`, [ids]);
    const byCapa = new Map<number, CapaAction[]>();
    for (const a of actRes.rows.map(mapCapaAction)) {
      const list = byCapa.get(a.capaId) ?? [];
      list.push(a);
      byCapa.set(a.capaId, list);
    }
    return capas.map((c) => ({ ...c, actions: byCapa.get(c.capaId) ?? [] }));
  }

  /** Insert an NCR, allocating the gapless NCR number inside the same transaction. */
  async create(ctx: RequestContext, h: NcrHeaderInput): Promise<Ncr> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO qms.ncr
           (company_id, bu_id, ncr_no, source, source_doc_id, item_id, project_id,
            failure_mode_id, severity, raised_date, status, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,$7,$8, COALESCE($9::date, current_date), 'OPEN', $10)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.source, h.sourceDocId ?? null, h.itemId ?? null,
          h.projectId ?? null, h.failureModeId ?? null, h.severity ?? null,
          h.raisedDate ?? null, ctx.userId,
        ]);
      const header = mapHeader(res.rows[0]);
      return { ...header, rca: [], capa: [] };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Ncr | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM qms.ncr
          WHERE ncr_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return {
        ...mapHeader(res.rows[0]),
        rca: await this.fetchRca(c, id),
        capa: await this.fetchCapa(c, id),
      };
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<NcrListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.source) { params.push(q.source); where.push(`source = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`ncr_no ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM qms.ncr WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM qms.ncr WHERE ${w}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()} LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Pareto / repeat-failure aggregation (READ-ONLY): one GROUP BY over qms.ncr for
   * the chosen dimension, ordered by count DESC. Company-scoped (explicit
   * company_id = $1 on top of RLS) and excludes soft-deleted rows; an optional
   * raised_date window narrows the population. By failure mode it LEFT JOINs
   * qms.failure_mode for fm_name (a NULL failure_mode_id stays a NULL key — the
   * service buckets it as 'Unclassified'). For severity/source it groups on the
   * column directly. Returns raw {key,label,count}; an empty company yields [].
   */
  async paretoCounts(ctx: RequestContext, q: ParetoQueryDto): Promise<ParetoCount[]> {
    // The grouped key + label expression per dimension. Counts are computed in SQL;
    // % and cumulative are derived in the service from this ordered list.
    const dim = q.by === 'severity'
      ? { key: 'n.severity', label: 'n.severity', join: '' }
      : q.by === 'source'
        ? { key: 'n.source', label: 'n.source', join: '' }
        : {
            key: 'n.failure_mode_id',
            label: 'fm.fm_name',
            join: 'LEFT JOIN qms.failure_mode fm ON fm.failure_mode_id = n.failure_mode_id',
          };

    const where: string[] = ['n.company_id = $1', 'NOT n.is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.fromDate) { params.push(q.fromDate); where.push(`n.raised_date >= $${params.length}`); }
    if (q.toDate) { params.push(q.toDate); where.push(`n.raised_date <= $${params.length}`); }
    const w = where.join(' AND ');

    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ key: string | null; label: string | null; cnt: string }>(
        `SELECT ${dim.key} AS key, ${dim.label} AS label, count(*)::text AS cnt
           FROM qms.ncr n
           ${dim.join}
          WHERE ${w}
          GROUP BY ${dim.key}, ${dim.label}
          ORDER BY count(*) DESC, ${dim.key} ASC NULLS LAST`,
        params);
      return res.rows.map((r) => ({
        // failure_mode_id is numeric; severity/source are text. Normalise here.
        key: r.key == null ? null : (q.by === 'mode' ? Number(r.key) : r.key),
        label: r.label ?? '',
        count: Number(r.cnt),
      }));
    });
  }

  /**
   * Insert an RCA child and (optionally) advance the NCR status, all under one
   * optimistic lock on the NCR. The parent row_version is bumped so the child
   * write participates in concurrency control. Returns null on a version mismatch.
   */
  async addRca(
    ctx: RequestContext, ncrId: number, expectedVersion: number, rca: RcaInput, advanceTo?: NcrStatus,
  ): Promise<Ncr | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const ncr = await this.bumpNcr(c, ctx, ncrId, expectedVersion, advanceTo);
      if (!ncr) return null;
      await c.query(
        `INSERT INTO qms.rca (ncr_id, method, root_cause, analysis, analysed_by, analysed_at)
         VALUES ($1,$2,$3,$4,$5, now())`,
        [ncrId, rca.method, rca.rootCause ?? null,
         rca.analysis ? JSON.stringify(rca.analysis) : null, ctx.userId]);
      return this.hydrate(c, ncr, ncrId);
    });
  }

  /**
   * Insert a CAPA child and (optionally) advance the NCR status under one optimistic
   * lock on the NCR. Returns null on a version mismatch.
   */
  async addCapa(
    ctx: RequestContext, ncrId: number, expectedVersion: number, capa: CapaInput, advanceTo?: NcrStatus,
  ): Promise<Ncr | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const ncr = await this.bumpNcr(c, ctx, ncrId, expectedVersion, advanceTo);
      if (!ncr) return null;
      await c.query(
        `INSERT INTO qms.capa (ncr_id, capa_type, action, owner_id, due_date, effectiveness_check, status)
         VALUES ($1,$2,$3,$4,$5,$6,'OPEN')`,
        [ncrId, capa.capaType, capa.action, capa.ownerId ?? null,
         capa.dueDate ?? null, capa.effectivenessCheck ?? null]);
      return this.hydrate(c, ncr, ncrId);
    });
  }

  /**
   * Add a step under a CAPA belonging to the NCR. Scoped by a join to qms.capa so a
   * caller cannot attach an action to another NCR's CAPA. Returns the persisted action,
   * or null if the CAPA does not belong to this NCR.
   */
  async addCapaAction(
    ctx: RequestContext, ncrId: number, capaId: number, action: CapaActionInput,
  ): Promise<CapaAction | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const owns = await c.query(
        `SELECT 1 FROM qms.capa WHERE capa_id = $1 AND ncr_id = $2`, [capaId, ncrId]);
      if (!owns.rowCount) return null;
      const res = await c.query(
        `INSERT INTO qms.capa_action (capa_id, description, owner_id, due_date, status)
         VALUES ($1,$2,$3,$4,'OPEN')
         RETURNING capa_action_id, capa_id, description, owner_id, due_date, done_date, status`,
        [capaId, action.description, action.ownerId ?? null, action.dueDate ?? null]);
      return mapCapaAction(res.rows[0]);
    });
  }

  /**
   * Update a CAPA's status (e.g. -> VERIFIED) when it belongs to the NCR. Returns
   * the refreshed CAPA, or null if the CAPA is not under this NCR.
   */
  async updateCapaStatus(
    ctx: RequestContext, ncrId: number, capaId: number, status: CapaStatus, effectivenessCheck?: string,
  ): Promise<Capa | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const set: string[] = ['status = $1'];
      const params: unknown[] = [status];
      if (effectivenessCheck !== undefined) {
        params.push(effectivenessCheck); set.push(`effectiveness_check = $${params.length}`);
      }
      params.push(capaId); const pCapa = params.length;
      params.push(ncrId); const pNcr = params.length;
      const res = await c.query(
        `UPDATE qms.capa SET ${set.join(', ')}
          WHERE capa_id = $${pCapa} AND ncr_id = $${pNcr}
        RETURNING capa_id, capa_type, action, owner_id, due_date, effectiveness_check, status`, params);
      if (!res.rowCount) return null;
      const actRes = await c.query(
        `SELECT capa_action_id, capa_id, description, owner_id, due_date, done_date, status
           FROM qms.capa_action WHERE capa_id = $1 ORDER BY capa_action_id`, [capaId]);
      return { ...mapCapa(res.rows[0]), actions: actRes.rows.map(mapCapaAction) };
    });
  }

  /**
   * Close the NCR (CAPA -> CLOSED) under optimistic lock and emit the outbox event
   * atomically with the state change (transactional outbox). Returns null on a
   * version mismatch.
   */
  async close(
    ctx: RequestContext, ncrId: number, expectedVersion: number, event: OutboxEventInput,
  ): Promise<Ncr | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const ncr = await this.bumpNcr(c, ctx, ncrId, expectedVersion, 'CLOSED');
      if (!ncr) return null;
      await emitOutbox(c, event);
      return this.hydrate(c, ncr, ncrId);
    });
  }

  /** Soft delete. Returns true if a row was deleted. */
  async softDelete(ctx: RequestContext, id: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE qms.ncr
            SET is_deleted = true, updated_by = $1, updated_at = now(),
                row_version = row_version + 1
          WHERE ncr_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * Optimistic-locked bump of the NCR header: stamps updated_by, increments
   * row_version, and (optionally) sets a new status — all inside the caller's
   * transaction so a child write advances the parent atomically. Returns the new
   * header, or null on a row-version mismatch.
   */
  private async bumpNcr(
    c: Queryable, ctx: RequestContext, ncrId: number, expectedVersion: number, status?: NcrStatus,
  ): Promise<Header | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    if (status) { params.push(status); set.push(`status = $${params.length}`); }
    params.push(ctx.userId); set.push(`updated_by = $${params.length}`);
    params.push(ncrId); const pId = params.length;
    params.push(ctx.companyId); const pCo = params.length;
    params.push(expectedVersion); const pVer = params.length;
    const res = await c.query(
      `UPDATE qms.ncr SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
        WHERE ncr_id = $${pId} AND company_id = $${pCo} AND row_version = $${pVer} AND NOT is_deleted
      RETURNING ${H}`, params);
    return res.rowCount ? mapHeader(res.rows[0]) : null;
  }

  /** Re-read both child collections onto an already-updated header. */
  private async hydrate(c: Queryable, header: Header, ncrId: number): Promise<Ncr> {
    return {
      ...header,
      rca: await this.fetchRca(c, ncrId),
      capa: await this.fetchCapa(c, ncrId),
    };
  }
}
