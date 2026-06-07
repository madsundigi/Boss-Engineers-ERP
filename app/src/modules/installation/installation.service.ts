import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { InstallationRepository, InstallationHeaderInput } from './installation.repository';
import { Installation, InstallationListResult, PunchItem } from './installation.types';
import {
  CreateInstallationDto, UpdateInstallationDto, CommissionDto, AcceptDto, ListQueryDto,
} from './installation.dto';
import {
  canTransition, InstallationStatus, INSTALLATION_ACCEPTED_EVENT,
} from './installation.constants';

/** Statuses where the header / punch list may still be edited. */
const EDITABLE: InstallationStatus[] = ['PLANNED', 'IN_PROGRESS'];

/** Count of punch items still OPEN — any OPEN item blocks customer acceptance. */
export function openPunchCount(d: Pick<Installation, 'punchItems'>): number {
  return d.punchItems.filter((p) => p.status === 'OPEN').length;
}

/**
 * InstallationService — business logic for the Installation & Commissioning
 * module (M12). Stateless; depends only on the repository (injected) so it is
 * unit-testable without a database. Drives the site lifecycle PLANNED ->
 * IN_PROGRESS -> COMMISSIONED (SAT) -> ACCEPTED -> CLOSED. Acceptance is gated on
 * a PASSED SAT and zero OPEN punch items, and emits 'installation.accepted'
 * (warranty clock start downstream).
 */
export class InstallationService {
  constructor(private readonly repo: InstallationRepository) {}

  private mapPunch(dto?: CreateInstallationDto['punchItems']): PunchItem[] {
    return (dto ?? []).map((p) => ({
      description: p.description, severity: p.severity ?? null,
      status: p.status, closedDate: p.closedDate ?? null,
    }));
  }

  async create(ctx: RequestContext, dto: CreateInstallationDto): Promise<Installation> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate an installation number');
    }
    const header: InstallationHeaderInput = {
      projectId: dto.projectId, dispatchId: dto.dispatchId,
      siteAddress: dto.siteAddress, plannedDate: dto.plannedDate,
    };
    return this.repo.create(ctx, header, this.mapPunch(dto.punchItems));
  }

  async getById(ctx: RequestContext, id: number): Promise<Installation> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Installation ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<InstallationListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateInstallationDto): Promise<Installation> {
    const { rowVersion, punchItems, ...rest } = dto;
    const fields = rest as Partial<InstallationHeaderInput>;
    if (Object.keys(fields).length === 0 && !punchItems) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (!EDITABLE.includes(existing.status)) {
      throw Errors.conflict(`Only a PLANNED or IN_PROGRESS installation can be edited (current: ${existing.status})`);
    }
    const updated = await this.repo.update(
      ctx, id, rowVersion, fields, punchItems ? this.mapPunch(punchItems) : undefined,
    );
    if (!updated) {
      throw Errors.conflict('Installation was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /** Begin site work: PLANNED -> IN_PROGRESS. */
  async start(ctx: RequestContext, id: number, rowVersion: number): Promise<Installation> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'IN_PROGRESS')) {
      throw Errors.conflict(`Only a PLANNED installation can be started (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'IN_PROGRESS');
    if (!updated) throw Errors.conflict('Installation was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Record the SAT (Site Acceptance Test) outcome: IN_PROGRESS -> COMMISSIONED.
   * Stamps sat_result (PASS/FAIL) and the actual_date. A FAIL is recorded too —
   * the SAT happened — but a subsequent acceptance is gated on a PASS.
   */
  async commission(ctx: RequestContext, id: number, dto: CommissionDto): Promise<Installation> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'COMMISSIONED')) {
      throw Errors.conflict(`Only an IN_PROGRESS installation can be commissioned (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'COMMISSIONED', {
      sat_result: dto.satResult,
      actual_date: dto.actualDate ?? new Date().toISOString().slice(0, 10),
    });
    if (!updated) throw Errors.conflict('Installation was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Customer acceptance / sign-off: COMMISSIONED -> ACCEPTED. Gated — requires a
   * PASSED SAT and zero OPEN punch items (else 409). Stamps acceptance_cert_no +
   * accepted_date and emits 'installation.accepted' atomically with the state
   * change so the warranty clock starts downstream.
   */
  async accept(ctx: RequestContext, id: number, dto: AcceptDto): Promise<Installation> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'ACCEPTED')) {
      throw Errors.conflict(`Only a COMMISSIONED installation can be accepted (current: ${existing.status})`);
    }
    if (existing.satResult !== 'PASS') {
      throw Errors.conflict(`Acceptance requires a PASSED SAT (current SAT result: ${existing.satResult})`);
    }
    const open = openPunchCount(existing);
    if (open > 0) {
      throw Errors.conflict(`Acceptance is blocked by ${open} open punch item(s); close them first`);
    }
    const updated = await this.repo.updateStatus(
      ctx, id, dto.rowVersion, 'ACCEPTED',
      {
        acceptance_cert_no: dto.acceptanceCertNo,
        accepted_date: dto.acceptedDate ?? new Date().toISOString().slice(0, 10),
      },
      {
        eventType: INSTALLATION_ACCEPTED_EVENT, aggregateType: 'INSTALLATION', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: {
          installNo: existing.installNo,
          projectId: existing.projectId,
          dispatchId: existing.dispatchId,
        },
      },
    );
    if (!updated) throw Errors.conflict('Installation was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Handover complete: ACCEPTED -> CLOSED. */
  async close(ctx: RequestContext, id: number, rowVersion: number): Promise<Installation> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CLOSED')) {
      throw Errors.conflict(`Only an ACCEPTED installation can be closed (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'CLOSED');
    if (!updated) throw Errors.conflict('Installation was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'PLANNED') {
      throw Errors.conflict(`Only a PLANNED installation can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** INSTALLATION.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Install No', 'Project', 'Dispatch', 'Planned Date', 'Actual Date', 'SAT', 'Status', 'Cert No', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.installNo, r.projectId, r.dispatchId, r.plannedDate, r.actualDate, r.satResult, r.status, r.acceptanceCertNo, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
