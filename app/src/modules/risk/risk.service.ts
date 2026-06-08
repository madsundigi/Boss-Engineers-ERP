import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { RiskRepository } from './risk.repository';
import { Risk, RiskListResult, RiskHeatmapRow } from './risk.types';
import { CreateRiskDto, UpdateRiskDto, ListQueryDto } from './risk.dto';
import { canTransition, RiskStatus, RISK_CLOSED_EVENT } from './risk.constants';

const TERMINAL: RiskStatus[] = ['CLOSED', 'ACCEPTED'];

/**
 * RiskService — project risk register business logic. Stateless; depends only on
 * the injected repository. Enforces the OPEN -> MITIGATING -> CLOSED/ACCEPTED
 * lifecycle and emits 'project_risk.closed' when a risk is retired.
 */
export class RiskService {
  constructor(private readonly repo: RiskRepository) {}

  create(ctx: RequestContext, dto: CreateRiskDto): Promise<Risk> {
    return this.repo.create(ctx, dto);
  }

  async getById(ctx: RequestContext, id: number): Promise<Risk> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Risk ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<RiskListResult> {
    return this.repo.list(ctx, query);
  }

  heatmap(ctx: RequestContext, projectId?: number): Promise<RiskHeatmapRow[]> {
    return this.repo.heatmap(ctx, projectId);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateRiskDto): Promise<Risk> {
    const { rowVersion, ...fields } = dto;
    const existing = await this.getById(ctx, id);
    if (TERMINAL.includes(existing.status)) {
      throw Errors.conflict(`Cannot edit a ${existing.status} risk`);
    }
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) throw Errors.conflict('Risk was modified by someone else (row version mismatch)');
    return updated;
  }

  private async transition(
    ctx: RequestContext, id: number, rowVersion: number, to: RiskStatus, emit: boolean,
  ): Promise<Risk> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, to)) {
      throw Errors.conflict(`Cannot move a ${existing.status} risk to ${to}`);
    }
    const event = emit ? {
      eventType: RISK_CLOSED_EVENT, aggregateType: 'PROJECT_RISK', aggregateId: id,
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: { riskId: id, projectId: existing.projectId, severity: existing.severity, status: to },
    } : undefined;
    const updated = await this.repo.setStatus(ctx, id, rowVersion, to, event);
    if (!updated) throw Errors.conflict('Risk was modified by someone else (row version mismatch)');
    return updated;
  }

  startMitigation(ctx: RequestContext, id: number, rowVersion: number): Promise<Risk> {
    return this.transition(ctx, id, rowVersion, 'MITIGATING', false);
  }
  close(ctx: RequestContext, id: number, rowVersion: number): Promise<Risk> {
    return this.transition(ctx, id, rowVersion, 'CLOSED', true);
  }
  accept(ctx: RequestContext, id: number, rowVersion: number): Promise<Risk> {
    return this.transition(ctx, id, rowVersion, 'ACCEPTED', true);
  }

  async delete(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'OPEN') {
      throw Errors.conflict(`Only an OPEN risk can be deleted (current: ${existing.status})`);
    }
    const ok = await this.repo.softDelete(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Risk was modified by someone else (row version mismatch)');
  }

  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Project', 'Title', 'Category', 'Likelihood', 'Impact', 'Severity', 'Status', 'Owner', 'Due'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.projectId, r.title, r.category, r.likelihood, r.impact, r.severity, r.status, r.ownerId, r.dueDate,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
