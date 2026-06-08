import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { EhsRepository } from './ehs.repository';
import { Incident, IncidentListResult } from './ehs.types';
import { CreateIncidentDto, UpdateIncidentDto, ListQueryDto } from './ehs.dto';
import { canTransition, IncidentStatus, EHS_INCIDENT_CLOSED_EVENT } from './ehs.constants';

/**
 * EhsService — EHS / Incident Register business logic. Stateless; depends only on the
 * injected repository so it is unit-testable without a database. Enforces the REPORTED
 * -> INVESTIGATING -> CLOSED lifecycle, requires a corrective action before close, and
 * emits 'ehs.incident.closed' (stamping closed_at) when an incident is signed off.
 */
export class EhsService {
  constructor(private readonly repo: EhsRepository) {}

  /** Log an incident (REPORTED). Requires a branch (ctx.buId) to allocate the
   *  branch-scoped INCIDENT number; reported_by is taken from request context. */
  async create(ctx: RequestContext, dto: CreateIncidentDto): Promise<Incident> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate an incident number');
    }
    return this.repo.create(ctx, dto);
  }

  async getById(ctx: RequestContext, id: number): Promise<Incident> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Incident ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<IncidentListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateIncidentDto): Promise<Incident> {
    const { rowVersion, ...fields } = dto;
    const existing = await this.getById(ctx, id);
    if (existing.status === 'CLOSED') {
      throw Errors.conflict('Cannot edit a CLOSED incident');
    }
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) throw Errors.conflict('Incident was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Begin the root-cause review (REPORTED -> INVESTIGATING, EHS.EDIT). */
  async startInvestigation(ctx: RequestContext, id: number, rowVersion: number): Promise<Incident> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'INVESTIGATING')) {
      throw Errors.conflict(`Cannot start investigation on a ${existing.status} incident`);
    }
    const updated = await this.repo.setStatus(ctx, id, rowVersion, 'INVESTIGATING');
    if (!updated) throw Errors.conflict('Incident was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Sign off an INVESTIGATING incident (INVESTIGATING -> CLOSED, EHS.APPROVE): requires
   * a corrective action to be recorded, stamps closed_at and emits 'ehs.incident.closed'
   * — all atomically.
   */
  async close(ctx: RequestContext, id: number, rowVersion: number): Promise<Incident> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CLOSED')) {
      throw Errors.conflict(`Cannot close a ${existing.status} incident`);
    }
    if (!existing.correctiveAction || !existing.correctiveAction.trim()) {
      throw Errors.badRequest('A corrective action is required before an incident can be closed');
    }
    const updated = await this.repo.setStatus(ctx, id, rowVersion, 'CLOSED', {
      setClosedAt: true,
      event: {
        eventType: EHS_INCIDENT_CLOSED_EVENT, aggregateType: 'EHS_INCIDENT', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: { incidentNo: existing.incidentNo, incidentType: existing.incidentType, severity: existing.severity },
      },
    });
    if (!updated) throw Errors.conflict('Incident was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'REPORTED') {
      throw Errors.conflict(`Only a REPORTED incident can be deleted (current: ${existing.status})`);
    }
    const ok = await this.repo.softDelete(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Incident was modified by someone else (row version mismatch)');
  }

  /** EHS.EXPORT — CSV of the (filtered) incident list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Incident No', 'Date', 'Type', 'Severity', 'Location', 'Project', 'Status', 'Corrective Action', 'Closed At'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.incidentNo, r.incidentDate, r.incidentType, r.severity, r.location, r.projectId,
      r.status, r.correctiveAction, r.closedAt,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
