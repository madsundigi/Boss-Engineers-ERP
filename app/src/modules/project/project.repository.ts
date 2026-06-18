import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { Project, ProjectListResult } from './project.types';
import { ListQueryDto } from './project.dto';
import { DOC_TYPE, ProjectStatus } from './project.constants';

const COLS = `project_id, project_no, company_id, bu_id, project_name, customer_id,
  quotation_id, enquiry_id, contract_value, budget_cost, pm_user_id, planned_start, planned_end,
  contractual_end, ld_pct_per_week, status, health_rag,
  created_at, created_by, updated_at, row_version`;

function mapRow(r: QueryResultRow): Project {
  return {
    projectId: Number(r.project_id),
    projectNo: r.project_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    projectName: r.project_name,
    customerId: Number(r.customer_id),
    quotationId: r.quotation_id == null ? null : Number(r.quotation_id),
    enquiryId: r.enquiry_id == null ? null : Number(r.enquiry_id),
    contractValue: Number(r.contract_value),
    budgetCost: Number(r.budget_cost),
    pmUserId: Number(r.pm_user_id),
    plannedStart: r.planned_start,
    plannedEnd: r.planned_end,
    contractualEnd: r.contractual_end,
    ldPctPerWeek: r.ld_pct_per_week == null ? null : Number(r.ld_pct_per_week),
    status: r.status,
    healthRag: r.health_rag,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}

export interface CreateProjectRow {
  projectName: string;
  customerId: number;
  pmUserId: number;
  contractValue: number;
  budgetCost: number;
  quotationId?: number | null;
  enquiryId?: number | null;
  plannedStart?: string;
  plannedEnd?: string;
  contractualEnd?: string;
  ldPctPerWeek?: number;
}

export type StatusPatch = Partial<Record<'health_rag', unknown>>;

export class ProjectRepository {
  constructor(private readonly pool: Pool) {}

  /** Insert, allocating the gapless project number inside the same transaction. */
  async create(ctx: RequestContext, data: CreateProjectRow, event?: OutboxEventInput): Promise<Project> {
    return runInContext(this.pool, ctx, async (client: Queryable) => {
      const res = await client.query(
        `INSERT INTO proj.project
           (company_id, bu_id, project_no, project_name, customer_id, quotation_id,
            contract_value, budget_cost, pm_user_id, planned_start, planned_end,
            contractual_end, ld_pct_per_week, status, created_by, enquiry_id)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PLANNING',$13,$14)
         RETURNING ${COLS}`,
        [
          ctx.companyId, ctx.buId, data.projectName, data.customerId, data.quotationId ?? null,
          data.contractValue, data.budgetCost, data.pmUserId, data.plannedStart ?? null,
          data.plannedEnd ?? null, data.contractualEnd ?? null, data.ldPctPerWeek ?? null, ctx.userId,
          data.enquiryId ?? null,
        ],
      );
      // Atomic with the insert: record the domain event (transactional outbox).
      if (event) await emitOutbox(client, event);
      return mapRow(res.rows[0]);
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<Project | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${COLS} FROM proj.project
          WHERE project_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId],
      );
      return res.rowCount ? mapRow(res.rows[0]) : null;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<ProjectListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.customerId) { params.push(q.customerId); where.push(`customer_id = $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`);
      const i = params.length;
      where.push(`(project_no ILIKE $${i} OR project_name ILIKE $${i})`);
    }
    const whereSql = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const totalRes = await c.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM proj.project WHERE ${whereSql}`,
        params,
      );
      const total = Number(totalRes.rows[0].total);

      const rowsRes = await c.query(
        `SELECT ${COLS} FROM proj.project WHERE ${whereSql}
          ORDER BY ${q.sort} ${q.dir.toUpperCase()}
          LIMIT ${q.pageSize} OFFSET ${offset}`,
        params,
      );
      return { rows: rowsRes.rows.map(mapRow), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked field update. Returns null if version did not match. */
  async update(
    ctx: RequestContext,
    id: number,
    expectedVersion: number,
    fields: Partial<CreateProjectRow & { healthRag: string }>,
  ): Promise<Project | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.projectName !== undefined) add('project_name', fields.projectName);
    if (fields.customerId !== undefined) add('customer_id', fields.customerId);
    if (fields.pmUserId !== undefined) add('pm_user_id', fields.pmUserId);
    if (fields.contractValue !== undefined) add('contract_value', fields.contractValue);
    if (fields.budgetCost !== undefined) add('budget_cost', fields.budgetCost);
    if (fields.quotationId !== undefined) add('quotation_id', fields.quotationId);
    if (fields.plannedStart !== undefined) add('planned_start', fields.plannedStart);
    if (fields.plannedEnd !== undefined) add('planned_end', fields.plannedEnd);
    if (fields.contractualEnd !== undefined) add('contractual_end', fields.contractualEnd);
    if (fields.ldPctPerWeek !== undefined) add('ld_pct_per_week', fields.ldPctPerWeek);
    if (fields.healthRag !== undefined) add('health_rag', fields.healthRag);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (client) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await client.query(
        `UPDATE proj.project
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE project_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${COLS}`,
        params,
      );
      return res.rowCount ? mapRow(res.rows[0]) : null;
    });
  }

  /**
   * Optimistic-locked status transition. When `version` is null the guard is
   * skipped (caller already verified). Emits an optional domain event atomically
   * with the state change (transactional outbox — same pattern as quotation).
   */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number | null,
    status: ProjectStatus, patch: StatusPatch = {}, event?: OutboxEventInput,
  ): Promise<Project | null> {
    const set: string[] = ['status = $1']; const params: unknown[] = [status];
    for (const [col, val] of Object.entries(patch)) { params.push(val); set.push(`${col} = $${params.length}`); }
    params.push(ctx.userId); set.push(`updated_by = $${params.length}`);
    return runInContext(this.pool, ctx, async (client) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      let verClause = '';
      if (expectedVersion !== null) { params.push(expectedVersion); verClause = ` AND row_version = $${params.length}`; }
      const res = await client.query(
        `UPDATE proj.project
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE project_id = $${pId} AND company_id = $${pCo} AND NOT is_deleted${verClause}
        RETURNING ${COLS}`,
        params,
      );
      if (!res.rowCount) return null;
      if (event) await emitOutbox(client, event);
      return mapRow(res.rows[0]);
    });
  }
}
