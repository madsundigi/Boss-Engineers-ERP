import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { ProjectRepository } from './project.repository';
import { Project, ProjectListResult } from './project.types';
import { CreateProjectDto, UpdateProjectDto, ChangeStatusDto, ListQueryDto } from './project.dto';
import { canTransition, isEditable } from './project.constants';

/**
 * ProjectService — business logic for the Project Creation module (M03).
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. The project number is the costing spine every downstream
 * actual posts against, so creation is gated on a branch (for numbering) and the
 * charter is gated on a FINANCE/CEO sign-off before the project goes ACTIVE.
 */
export class ProjectService {
  constructor(private readonly repo: ProjectRepository) {}

  async create(ctx: RequestContext, dto: CreateProjectDto): Promise<Project> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a project number');
    }
    const data = {
      projectName: dto.projectName,
      customerId: dto.customerId,
      pmUserId: dto.pmUserId,
      contractValue: dto.contractValue,
      budgetCost: dto.budgetCost,
      quotationId: dto.quotationId,
      plannedStart: dto.plannedStart,
      plannedEnd: dto.plannedEnd,
      contractualEnd: dto.contractualEnd,
      ldPctPerWeek: dto.ldPctPerWeek,
    };
    const project = await this.repo.create(ctx, data, {
      eventType: 'project.created', aggregateType: 'PROJECT',
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: { quotationId: dto.quotationId ?? null, customerId: dto.customerId },
    });
    return project;
  }

  async getById(ctx: RequestContext, id: number): Promise<Project> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Project ${id} not found`);
    return row;
  }

  async list(ctx: RequestContext, query: ListQueryDto): Promise<ProjectListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateProjectDto): Promise<Project> {
    const { rowVersion, ...fields } = dto;
    if (Object.keys(fields).length === 0) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (!isEditable(existing.status)) {
      throw Errors.conflict(`Cannot edit a project in status ${existing.status} (only PLANNING/APPROVED are editable)`);
    }
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) {
      throw Errors.conflict('Project was modified by someone else (row version mismatch)', {
        expected: rowVersion,
        current: existing.rowVersion,
      });
    }
    return updated;
  }

  async changeStatus(ctx: RequestContext, id: number, dto: ChangeStatusDto): Promise<Project> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, dto.status)) {
      throw Errors.conflict(`Invalid status transition: ${existing.status} -> ${dto.status}`);
    }
    if (dto.status === 'CANCELLED' && !dto.reason) {
      throw Errors.badRequest('A reason is required when cancelling a project');
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, dto.status);
    if (!updated) {
      throw Errors.conflict('Project was modified by someone else (row version mismatch)');
    }
    return updated;
  }

  /**
   * Charter / budget baseline sign-off (PROJECT.APPROVE — FINANCE/CEO):
   * PLANNING -> APPROVED. The project must clear this gate before it can go
   * ACTIVE. Segregation of Duties: the creator may not approve their own charter.
   */
  async approve(ctx: RequestContext, id: number, rowVersion: number): Promise<Project> {
    const existing = await this.getById(ctx, id);
    if (existing.createdBy === ctx.userId) {
      throw Errors.forbidden('Segregation of Duties: you cannot approve a project you created');
    }
    if (existing.status !== 'PLANNING') {
      throw Errors.conflict(`Only a PLANNING project can be approved (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'APPROVED', {}, {
      eventType: 'project.approved', aggregateType: 'PROJECT', aggregateId: id,
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: { approvedBy: ctx.userId },
    });
    if (!updated) throw Errors.conflict('Project was modified by someone else (row version mismatch)');
    return updated;
  }

  /** PROJECT.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Project No', 'Project Name', 'Customer', 'Contract Value', 'Budget Cost', 'Status', 'Health', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.projectNo, r.projectName, r.customerId, r.contractValue, r.budgetCost, r.status, r.healthRag, r.createdAt].map(esc).join(','),
    );
    return [head.join(','), ...lines].join('\n');
  }
}
