import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  PlanningRepository, CreateTaskRow, UpdateTaskFields, TaskDependencyInput,
} from './planning.repository';
import {
  Baseline, Milestone, MilestoneListResult, Task, TaskListResult,
  WbsElement, WbsListResult,
} from './planning.types';
import {
  CreateWbsDto, CreateTaskDto, UpdateTaskDto, CreateMilestoneDto, UpdateMilestoneDto,
  ApproveBaselineDto,
} from './planning.dto';
import { BASELINE_APPROVED_EVENT } from './planning.constants';

/**
 * PlanningService — business logic for the Project Planning & Gantt module (M04).
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. Planning data is project-scoped and uses identity PKs (no
 * document numbering). The baseline is the plan-of-record every EVM / variance
 * calculation measures against, so it is gated on a PLANNING.APPROVE sign-off.
 */
export class PlanningService {
  constructor(private readonly repo: PlanningRepository) {}

  // ---- WBS ----------------------------------------------------------------

  async createWbs(ctx: RequestContext, projectId: number, dto: CreateWbsDto): Promise<WbsElement> {
    return this.repo.createWbs(ctx, projectId, {
      wbsCode: dto.wbsCode,
      wbsName: dto.wbsName,
      parentWbsId: dto.parentWbsId,
      budgetAmount: dto.budgetAmount,
      isBillingMilestone: dto.isBillingMilestone,
    });
  }

  listWbs(ctx: RequestContext, projectId: number): Promise<WbsListResult> {
    return this.repo.listWbs(ctx, projectId);
  }

  // ---- Tasks --------------------------------------------------------------

  /** Validate a predecessor set: no self-edges, no duplicate predecessors. */
  private normalizeDependencies(taskId: number | null, deps?: CreateTaskDto['dependencies']): TaskDependencyInput[] | undefined {
    if (deps === undefined) return undefined;
    const seen = new Set<number>();
    const out: TaskDependencyInput[] = [];
    for (const d of deps) {
      if (taskId !== null && d.predTaskId === taskId) {
        throw Errors.badRequest('A task cannot depend on itself');
      }
      if (seen.has(d.predTaskId)) {
        throw Errors.badRequest(`Duplicate dependency on predecessor ${d.predTaskId}`);
      }
      seen.add(d.predTaskId);
      out.push({ predTaskId: d.predTaskId, depType: d.depType, lagDays: d.lagDays });
    }
    return out;
  }

  async createTask(ctx: RequestContext, projectId: number, dto: CreateTaskDto): Promise<Task> {
    if (dto.plannedEnd < dto.plannedStart) {
      throw Errors.badRequest('plannedEnd must be on or after plannedStart');
    }
    const data: CreateTaskRow = {
      taskName: dto.taskName,
      wbsId: dto.wbsId,
      plannedStart: dto.plannedStart,
      plannedEnd: dto.plannedEnd,
      percentComplete: dto.percentComplete,
      dependencies: this.normalizeDependencies(null, dto.dependencies),
    };
    return this.repo.createTask(ctx, projectId, data);
  }

  async getTask(ctx: RequestContext, id: number): Promise<Task> {
    const row = await this.repo.findTaskById(ctx, id);
    if (!row) throw Errors.notFound(`Task ${id} not found`);
    return row;
  }

  /** The project schedule — tasks ordered by planned start (Gantt order). */
  schedule(ctx: RequestContext, projectId: number): Promise<TaskListResult> {
    return this.repo.listTasks(ctx, projectId);
  }

  async updateTask(ctx: RequestContext, id: number, dto: UpdateTaskDto): Promise<Task> {
    const { rowVersion, dependencies, ...rest } = dto;
    if (Object.keys(rest).length === 0 && dependencies === undefined) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getTask(ctx, id); // 404 if missing

    // Validate the resulting planned window (use the new value if supplied).
    const start = dto.plannedStart ?? existing.plannedStart;
    const end = dto.plannedEnd ?? existing.plannedEnd;
    if (end < start) {
      throw Errors.badRequest('plannedEnd must be on or after plannedStart');
    }
    const fields: UpdateTaskFields = {
      ...rest,
      dependencies: this.normalizeDependencies(id, dependencies),
    };
    const updated = await this.repo.updateTask(ctx, id, rowVersion, fields);
    if (!updated) {
      throw Errors.conflict('Task was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  // ---- Milestones ---------------------------------------------------------

  async createMilestone(ctx: RequestContext, projectId: number, dto: CreateMilestoneDto): Promise<Milestone> {
    return this.repo.createMilestone(ctx, projectId, {
      name: dto.name,
      wbsId: dto.wbsId,
      plannedDate: dto.plannedDate,
      isPaymentMilestone: dto.isPaymentMilestone,
      billPct: dto.billPct,
      billAmount: dto.billAmount,
    });
  }

  listMilestones(ctx: RequestContext, projectId: number): Promise<MilestoneListResult> {
    return this.repo.listMilestones(ctx, projectId);
  }

  async updateMilestone(ctx: RequestContext, id: number, dto: UpdateMilestoneDto): Promise<Milestone> {
    if (Object.keys(dto).length === 0) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.repo.findMilestoneById(ctx, id);
    if (!existing) throw Errors.notFound(`Milestone ${id} not found`);
    const updated = await this.repo.updateMilestone(ctx, id, dto);
    if (!updated) throw Errors.notFound(`Milestone ${id} not found`);
    return updated;
  }

  // ---- Baseline -----------------------------------------------------------

  /** Snapshot the current schedule into a new, monotonically-numbered baseline. */
  createBaseline(ctx: RequestContext, projectId: number): Promise<Baseline> {
    return this.repo.createBaseline(ctx, projectId);
  }

  /**
   * Approve a baseline (PLANNING.APPROVE). Only an as-yet-unapproved baseline can
   * be approved; a second approval is a 409. Emits the baseline-approved domain
   * event atomically with the approval.
   */
  async approveBaseline(ctx: RequestContext, dto: ApproveBaselineDto): Promise<Baseline> {
    const existing = await this.repo.findBaselineById(ctx, dto.baselineId);
    if (!existing) throw Errors.notFound(`Baseline ${dto.baselineId} not found`);
    if (existing.approvedAt) {
      throw Errors.conflict(`Baseline ${existing.baselineNo} is already approved`);
    }
    const approved = await this.repo.approveBaseline(ctx, dto.baselineId, {
      eventType: BASELINE_APPROVED_EVENT, aggregateType: 'PLANNING_BASELINE',
      aggregateId: dto.baselineId, companyId: ctx.companyId, createdBy: ctx.userId,
      payload: { projectId: existing.projectId, baselineNo: existing.baselineNo },
    });
    if (!approved) throw Errors.conflict('Baseline was modified by someone else');
    return approved;
  }
}
