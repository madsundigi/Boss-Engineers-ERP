import { Pool } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { OutboxEventInput, emitOutbox } from '../../outbox/outbox';
import { Risk, RiskListResult, RiskHeatmapRow } from './risk.types';
import { RiskStatus } from './risk.constants';
import { ListQueryDto } from './risk.dto';

const COLS = `risk_id, company_id, bu_id, project_id, title, description, category,
  likelihood, impact, severity, mitigation, owner_id, due_date, status,
  created_at, created_by, updated_at, row_version`;

type Row = Record<string, unknown>;
function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

function map(r: Row): Risk {
  return {
    riskId: Number(r.risk_id),
    companyId: Number(r.company_id),
    buId: num(r.bu_id),
    projectId: Number(r.project_id),
    title: r.title as string,
    description: (r.description as string) ?? null,
    category: (r.category as Risk['category']) ?? null,
    likelihood: Number(r.likelihood),
    impact: Number(r.impact),
    severity: Number(r.severity),
    mitigation: (r.mitigation as string) ?? null,
    ownerId: num(r.owner_id),
    dueDate: (r.due_date as string) ?? null,
    status: r.status as RiskStatus,
    createdAt: iso(r.created_at),
    createdBy: num(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}

export interface CreateRiskRow {
  projectId: number; title: string; description?: string; category?: string;
  likelihood: number; impact: number; mitigation?: string; ownerId?: number; dueDate?: string;
}
export type RiskFields = Partial<Omit<CreateRiskRow, 'projectId'>>;

const COL_OF: Record<string, string> = {
  title: 'title', description: 'description', category: 'category',
  likelihood: 'likelihood', impact: 'impact', mitigation: 'mitigation',
  ownerId: 'owner_id', dueDate: 'due_date',
};

export class RiskRepository {
  constructor(private readonly pool: Pool) {}

  async create(ctx: RequestContext, data: CreateRiskRow): Promise<Risk> {
    return runInContext(this.pool, ctx, async (c: Queryable) => {
      const res = await c.query(
        `INSERT INTO proj.project_risk
           (company_id, bu_id, project_id, title, description, category,
            likelihood, impact, mitigation, owner_id, due_date, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN',$12)
         RETURNING ${COLS}`,
        [ctx.companyId, ctx.buId, data.projectId, data.title, data.description ?? null,
         data.category ?? null, data.likelihood, data.impact, data.mitigation ?? null,
         data.ownerId ?? null, data.dueDate ?? null, ctx.userId]);
      return map(res.rows[0]);
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Risk | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${COLS} FROM proj.project_risk WHERE risk_id=$1 AND company_id=$2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      return res.rowCount ? map(res.rows[0]) : null;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<RiskListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.category) { params.push(q.category); where.push(`category = $${params.length}`); }
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`title ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';  // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;
    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM proj.project_risk WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${COLS} FROM proj.project_risk WHERE ${w}
          ORDER BY ${q.sort} ${dir}, risk_id DESC LIMIT ${lim} OFFSET ${off}`, params)).rows.map(map);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  async update(ctx: RequestContext, id: number, version: number, fields: RiskFields): Promise<Risk | null> {
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
        `UPDATE proj.project_risk
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE risk_id = $${pId} AND row_version = $${pVer} AND company_id = $${pCo} AND NOT is_deleted
          RETURNING ${COLS}`, params);
      return res.rowCount ? map(res.rows[0]) : null;
    });
  }

  async setStatus(
    ctx: RequestContext, id: number, version: number, status: RiskStatus, event?: OutboxEventInput,
  ): Promise<Risk | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE proj.project_risk
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE risk_id = $3 AND row_version = $4 AND company_id = $5 AND NOT is_deleted
          RETURNING ${COLS}`,
        [status, ctx.userId, id, version, ctx.companyId]);
      if (!res.rowCount) return null;
      if (event) await emitOutbox(c, event);
      return map(res.rows[0]);
    });
  }

  async softDelete(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE proj.project_risk
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE risk_id = $2 AND row_version = $3 AND company_id = $4 AND NOT is_deleted`,
        [ctx.userId, id, version, ctx.companyId]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  async heatmap(ctx: RequestContext, projectId?: number): Promise<RiskHeatmapRow[]> {
    const params: unknown[] = [ctx.companyId];
    let extra = '';
    if (projectId) { params.push(projectId); extra = `AND project_id = $${params.length}`; }
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT CASE WHEN severity >= 16 THEN 'CRITICAL' WHEN severity >= 10 THEN 'HIGH'
                     WHEN severity >= 5 THEN 'MEDIUM' ELSE 'LOW' END AS band,
                count(*)::int AS count
           FROM proj.project_risk
          WHERE company_id = $1 AND NOT is_deleted AND status IN ('OPEN','MITIGATING') ${extra}
          GROUP BY band`, params);
      return res.rows.map((r) => ({ band: r.band, count: Number(r.count) }));
    });
  }
}
