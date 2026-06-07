import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import {
  Baseline, Milestone, MilestoneListResult, Task, TaskDependency,
  TaskListResult, WbsElement, WbsListResult,
} from './planning.types';
import { DepType } from './planning.constants';

const WBS_COLS = `wbs_id, project_id, parent_wbs_id, wbs_code, wbs_name, budget_amount,
  is_billing_milestone, created_at, created_by, updated_at, row_version`;

const TASK_COLS = `task_id, project_id, wbs_id, task_name, planned_start, planned_end,
  actual_start, actual_end, baseline_start, baseline_end, percent_complete,
  is_critical_path, created_at, created_by, updated_at, row_version`;

const MS_COLS = `milestone_id, project_id, wbs_id, name, planned_date, actual_date,
  is_payment_milestone, bill_pct, bill_amount, status`;

const BASE_COLS = `baseline_id, project_id, baseline_no, approved_by, approved_at, created_at`;

/** Whole days between two YYYY-MM-DD dates, inclusive of both endpoints. */
function inclusiveDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.floor(ms / 86_400_000) + 1;
}

function mapWbs(r: QueryResultRow): WbsElement {
  return {
    wbsId: Number(r.wbs_id),
    projectId: Number(r.project_id),
    parentWbsId: r.parent_wbs_id == null ? null : Number(r.parent_wbs_id),
    wbsCode: r.wbs_code,
    wbsName: r.wbs_name,
    budgetAmount: Number(r.budget_amount),
    isBillingMilestone: r.is_billing_milestone,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
  };
}

function mapTask(r: QueryResultRow, dependencies: TaskDependency[] = []): Task {
  return {
    taskId: Number(r.task_id),
    projectId: Number(r.project_id),
    wbsId: r.wbs_id == null ? null : Number(r.wbs_id),
    taskName: r.task_name,
    plannedStart: r.planned_start,
    plannedEnd: r.planned_end,
    actualStart: r.actual_start,
    actualEnd: r.actual_end,
    baselineStart: r.baseline_start,
    baselineEnd: r.baseline_end,
    percentComplete: Number(r.percent_complete),
    isCriticalPath: r.is_critical_path,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: r.updated_at,
    rowVersion: Number(r.row_version),
    durationDays: inclusiveDays(r.planned_start, r.planned_end),
    dependencies,
  };
}

function mapDependency(r: QueryResultRow): TaskDependency {
  return {
    dependencyId: Number(r.dependency_id),
    predTaskId: Number(r.pred_task_id),
    depType: r.dep_type as DepType,
    lagDays: Number(r.lag_days),
  };
}

function mapMilestone(r: QueryResultRow): Milestone {
  return {
    milestoneId: Number(r.milestone_id),
    projectId: Number(r.project_id),
    wbsId: r.wbs_id == null ? null : Number(r.wbs_id),
    name: r.name,
    plannedDate: r.planned_date,
    actualDate: r.actual_date,
    isPaymentMilestone: r.is_payment_milestone,
    billPct: r.bill_pct == null ? null : Number(r.bill_pct),
    billAmount: r.bill_amount == null ? null : Number(r.bill_amount),
    status: r.status,
  };
}

function mapBaseline(r: QueryResultRow): Baseline {
  return {
    baselineId: Number(r.baseline_id),
    projectId: Number(r.project_id),
    baselineNo: Number(r.baseline_no),
    approvedBy: r.approved_by == null ? null : Number(r.approved_by),
    approvedAt: r.approved_at,
    createdAt: r.created_at,
  };
}

export interface CreateWbsRow {
  wbsCode: string;
  wbsName: string;
  parentWbsId?: number;
  budgetAmount: number;
  isBillingMilestone: boolean;
}

export interface TaskDependencyInput {
  predTaskId: number;
  depType: DepType;
  lagDays: number;
}

export interface CreateTaskRow {
  taskName: string;
  wbsId?: number;
  plannedStart: string;
  plannedEnd: string;
  percentComplete: number;
  dependencies?: TaskDependencyInput[];
}

/** Editable task fields (camelCase -> column mapped in update()). */
export interface UpdateTaskFields {
  taskName?: string;
  wbsId?: number;
  plannedStart?: string;
  plannedEnd?: string;
  actualStart?: string;
  actualEnd?: string;
  percentComplete?: number;
  isCriticalPath?: boolean;
  dependencies?: TaskDependencyInput[];
}

export interface CreateMilestoneRow {
  name: string;
  wbsId?: number;
  plannedDate?: string;
  isPaymentMilestone: boolean;
  billPct?: number;
  billAmount?: number;
}

export interface UpdateMilestoneFields {
  name?: string;
  plannedDate?: string;
  actualDate?: string;
  status?: string;
  billPct?: number;
  billAmount?: number;
}

export class PlanningRepository {
  constructor(private readonly pool: Pool) {}

  // ---- WBS ----------------------------------------------------------------

  async createWbs(ctx: RequestContext, projectId: number, data: CreateWbsRow): Promise<WbsElement> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO proj.wbs_element
           (company_id, project_id, parent_wbs_id, wbs_code, wbs_name, budget_amount,
            is_billing_milestone, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${WBS_COLS}`,
        [
          ctx.companyId, projectId, data.parentWbsId ?? null, data.wbsCode, data.wbsName,
          data.budgetAmount, data.isBillingMilestone, ctx.userId,
        ]);
      return mapWbs(res.rows[0]);
    });
  }

  async listWbs(ctx: RequestContext, projectId: number): Promise<WbsListResult> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${WBS_COLS} FROM proj.wbs_element
          WHERE project_id = $1 AND company_id = $2 AND NOT is_deleted
          ORDER BY wbs_code`,
        [projectId, ctx.companyId]);
      return { rows: res.rows.map(mapWbs), total: res.rowCount ?? 0 };
    });
  }

  // ---- Tasks --------------------------------------------------------------

  private async fetchDependencies(q: Queryable, taskId: number): Promise<TaskDependency[]> {
    const res = await q.query(
      `SELECT dependency_id, pred_task_id, dep_type, lag_days
         FROM proj.task_dependency WHERE succ_task_id = $1 ORDER BY dependency_id`,
      [taskId]);
    return res.rows.map(mapDependency);
  }

  private async replaceDependencies(q: Queryable, taskId: number, deps: TaskDependencyInput[]): Promise<void> {
    await q.query(`DELETE FROM proj.task_dependency WHERE succ_task_id = $1`, [taskId]);
    for (const d of deps) {
      await q.query(
        `INSERT INTO proj.task_dependency (pred_task_id, succ_task_id, dep_type, lag_days)
         VALUES ($1,$2,$3,$4)`,
        [d.predTaskId, taskId, d.depType, d.lagDays]);
    }
  }

  async createTask(ctx: RequestContext, projectId: number, data: CreateTaskRow): Promise<Task> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO proj.task
           (company_id, project_id, wbs_id, task_name, planned_start, planned_end,
            percent_complete, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${TASK_COLS}`,
        [
          ctx.companyId, projectId, data.wbsId ?? null, data.taskName,
          data.plannedStart, data.plannedEnd, data.percentComplete, ctx.userId,
        ]);
      const taskId = Number(res.rows[0].task_id);
      if (data.dependencies && data.dependencies.length > 0) {
        await this.replaceDependencies(c, taskId, data.dependencies);
      }
      return mapTask(res.rows[0], await this.fetchDependencies(c, taskId));
    });
  }

  async findTaskById(ctx: RequestContext, id: number): Promise<Task | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${TASK_COLS} FROM proj.task
          WHERE task_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return mapTask(res.rows[0], await this.fetchDependencies(c, id));
    });
  }

  /** The project schedule — tasks ordered by planned start (Gantt order). */
  async listTasks(ctx: RequestContext, projectId: number): Promise<TaskListResult> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${TASK_COLS} FROM proj.task
          WHERE project_id = $1 AND company_id = $2 AND NOT is_deleted
          ORDER BY planned_start, task_id`,
        [projectId, ctx.companyId]);
      const rows: Task[] = [];
      for (const r of res.rows) {
        rows.push(mapTask(r, await this.fetchDependencies(c, Number(r.task_id))));
      }
      return { rows, total: res.rowCount ?? 0 };
    });
  }

  /** Optimistic-locked task update. Returns null on a row-version mismatch. */
  async updateTask(
    ctx: RequestContext, id: number, expectedVersion: number, fields: UpdateTaskFields,
  ): Promise<Task | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.taskName !== undefined) add('task_name', fields.taskName);
    if (fields.wbsId !== undefined) add('wbs_id', fields.wbsId);
    if (fields.plannedStart !== undefined) add('planned_start', fields.plannedStart);
    if (fields.plannedEnd !== undefined) add('planned_end', fields.plannedEnd);
    if (fields.actualStart !== undefined) add('actual_start', fields.actualStart);
    if (fields.actualEnd !== undefined) add('actual_end', fields.actualEnd);
    if (fields.percentComplete !== undefined) add('percent_complete', fields.percentComplete);
    if (fields.isCriticalPath !== undefined) add('is_critical_path', fields.isCriticalPath);
    add('updated_by', ctx.userId);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE proj.task
            SET ${set.join(', ')}, updated_at = now(), row_version = row_version + 1
          WHERE task_id = $${pId} AND company_id = $${pCo}
            AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${TASK_COLS}`,
        params);
      if (!res.rowCount) return null;
      // Replace the predecessor set when the caller supplied one (we own it).
      if (fields.dependencies !== undefined) {
        await this.replaceDependencies(c, id, fields.dependencies);
      }
      return mapTask(res.rows[0], await this.fetchDependencies(c, id));
    });
  }

  // ---- Milestones ---------------------------------------------------------

  async createMilestone(ctx: RequestContext, projectId: number, data: CreateMilestoneRow): Promise<Milestone> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO proj.milestone
           (company_id, project_id, wbs_id, name, planned_date, is_payment_milestone,
            bill_pct, bill_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')
         RETURNING ${MS_COLS}`,
        [
          ctx.companyId, projectId, data.wbsId ?? null, data.name, data.plannedDate ?? null,
          data.isPaymentMilestone, data.billPct ?? null, data.billAmount ?? null,
        ]);
      return mapMilestone(res.rows[0]);
    });
  }

  async findMilestoneById(ctx: RequestContext, id: number): Promise<Milestone | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${MS_COLS} FROM proj.milestone
          WHERE milestone_id = $1 AND company_id = $2`,
        [id, ctx.companyId]);
      return res.rowCount ? mapMilestone(res.rows[0]) : null;
    });
  }

  async listMilestones(ctx: RequestContext, projectId: number): Promise<MilestoneListResult> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${MS_COLS} FROM proj.milestone
          WHERE project_id = $1 AND company_id = $2
          ORDER BY planned_date NULLS LAST, milestone_id`,
        [projectId, ctx.companyId]);
      return { rows: res.rows.map(mapMilestone), total: res.rowCount ?? 0 };
    });
  }

  async updateMilestone(ctx: RequestContext, id: number, fields: UpdateMilestoneFields): Promise<Milestone | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); set.push(`${col} = $${params.length}`); };
    if (fields.name !== undefined) add('name', fields.name);
    if (fields.plannedDate !== undefined) add('planned_date', fields.plannedDate);
    if (fields.actualDate !== undefined) add('actual_date', fields.actualDate);
    if (fields.status !== undefined) add('status', fields.status);
    if (fields.billPct !== undefined) add('bill_pct', fields.billPct);
    if (fields.billAmount !== undefined) add('bill_amount', fields.billAmount);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      const res = await c.query(
        `UPDATE proj.milestone SET ${set.join(', ')}
          WHERE milestone_id = $${pId} AND company_id = $${pCo}
        RETURNING ${MS_COLS}`,
        params);
      return res.rowCount ? mapMilestone(res.rows[0]) : null;
    });
  }

  // ---- Baseline -----------------------------------------------------------

  /**
   * Snapshot the project schedule into a new, monotonically-numbered baseline.
   * The next baseline_no is allocated inside the transaction; the snapshot is a
   * JSON copy of the current tasks (task_id, planned dates, % complete) and we
   * stamp each task's baseline_start/baseline_end so plan-vs-actual variance can
   * be computed thereafter. Returns the created baseline header.
   */
  async createBaseline(ctx: RequestContext, projectId: number): Promise<Baseline> {
    return runInContext(this.pool, ctx, async (c) => {
      const noRes = await c.query<{ next_no: string }>(
        `SELECT COALESCE(MAX(baseline_no), 0) + 1 AS next_no
           FROM proj.baseline WHERE project_id = $1 AND company_id = $2`,
        [projectId, ctx.companyId]);
      const nextNo = Number(noRes.rows[0].next_no);

      const tasksRes = await c.query(
        `SELECT task_id, planned_start, planned_end, percent_complete
           FROM proj.task
          WHERE project_id = $1 AND company_id = $2 AND NOT is_deleted
          ORDER BY task_id`,
        [projectId, ctx.companyId]);
      const snapshot = JSON.stringify(tasksRes.rows);

      const res = await c.query(
        `INSERT INTO proj.baseline (company_id, project_id, baseline_no, snapshot)
         VALUES ($1,$2,$3,$4::jsonb)
         RETURNING ${BASE_COLS}`,
        [ctx.companyId, projectId, nextNo, snapshot]);

      // Freeze the current plan onto each task as the baseline reference.
      await c.query(
        `UPDATE proj.task
            SET baseline_start = planned_start, baseline_end = planned_end,
                updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE project_id = $2 AND company_id = $3 AND NOT is_deleted`,
        [ctx.userId, projectId, ctx.companyId]);

      return mapBaseline(res.rows[0]);
    });
  }

  async findBaselineById(ctx: RequestContext, id: number): Promise<Baseline | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${BASE_COLS} FROM proj.baseline
          WHERE baseline_id = $1 AND company_id = $2`,
        [id, ctx.companyId]);
      return res.rowCount ? mapBaseline(res.rows[0]) : null;
    });
  }

  /**
   * Approve a baseline — stamp approver + timestamp. Idempotency / re-approval is
   * guarded in the service (only an unapproved baseline reaches here). Emits an
   * optional domain event atomically with the approval (transactional outbox).
   */
  async approveBaseline(ctx: RequestContext, id: number, event?: OutboxEventInput): Promise<Baseline | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE proj.baseline
            SET approved_by = $1, approved_at = now()
          WHERE baseline_id = $2 AND company_id = $3 AND approved_at IS NULL
        RETURNING ${BASE_COLS}`,
        [ctx.userId, id, ctx.companyId]);
      if (!res.rowCount) return null;
      if (event) await emitOutbox(c, event);
      return mapBaseline(res.rows[0]);
    });
  }
}
