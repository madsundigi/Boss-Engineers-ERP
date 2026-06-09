import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { FatRepository, CreateFatRow } from './fat.repository';
import { Fat, FatListResult, FatResultLine, PunchItem } from './fat.types';
import {
  CreateFatDto, UpdateFatDto, RecordResultDto, ChangeStatusDto, ApproveDto, ListQueryDto,
} from './fat.dto';
import {
  canTransition, FatResult, FatStatus, DISPATCH_CLEARANCE_STATUS, FAT_PASSED_EVENT,
} from './fat.constants';

/** A status that no longer permits header edits / result entry. */
const TERMINAL: FatStatus[] = ['CLEARED', 'CANCELLED'];

/** Outcome -> lifecycle status reached after recording the result. */
function statusForResult(result: FatResult): FatStatus {
  return result === 'PASS' ? 'PASSED' : 'FAILED'; // CONDITIONAL also requires rework -> FAILED
}

/**
 * FatService — business logic for the Factory Acceptance Test module (M10).
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. Enforces the protocol -> execution -> sign-off lifecycle
 * and the FAT clearance gate that Dispatch depends on.
 */
export class FatService {
  constructor(private readonly repo: FatRepository) {}

  async create(ctx: RequestContext, dto: CreateFatDto): Promise<Fat> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a FAT number');
    }
    const data: CreateFatRow = {
      projectId: dto.projectId, protocolId: dto.protocolId, woId: dto.woId,
      fatDate: dto.fatDate, customerWitness: dto.customerWitness, engineerId: dto.engineerId,
    };
    return this.repo.create(ctx, data);
  }

  async getById(ctx: RequestContext, id: number): Promise<Fat> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`FAT ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<FatListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateFatDto): Promise<Fat> {
    const { rowVersion, ...fields } = dto;
    if (Object.keys(fields).length === 0) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (TERMINAL.includes(existing.status)) {
      throw Errors.conflict(`Cannot edit a FAT in status ${existing.status}`);
    }
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) {
      throw Errors.conflict('FAT was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Record the test execution outcome (PASS/FAIL/CONDITIONAL). Only a SCHEDULED
   * or IN_PROGRESS FAT can be executed; a failure/conditional MUST carry a punch
   * list of the defects found. Moves the lifecycle to PASSED or FAILED.
   */
  async recordResult(ctx: RequestContext, id: number, dto: RecordResultDto): Promise<Fat> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'SCHEDULED' && existing.status !== 'IN_PROGRESS') {
      throw Errors.conflict(`Results can only be recorded for a SCHEDULED/IN_PROGRESS FAT (current: ${existing.status})`);
    }
    const punchItems = dto.punchItems ?? [];
    if (dto.result !== 'PASS' && punchItems.length === 0) {
      throw Errors.badRequest('A punch list (at least one item) is required when a FAT does not PASS');
    }
    const lines: FatResultLine[] = (dto.lines ?? []).map((l) => ({
      paramId: l.paramId, measuredValue: l.measuredValue ?? null, passFail: l.passFail,
    }));
    const items: PunchItem[] = punchItems.map((p) => ({
      description: p.description, severity: p.severity ?? null, status: 'OPEN', closedDate: null,
    }));
    const updated = await this.repo.recordResult(
      ctx, id, dto.rowVersion, statusForResult(dto.result), dto.result, lines, items);
    if (!updated) throw Errors.conflict('FAT was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Guarded lifecycle transition (e.g. re-open a FAILED FAT to IN_PROGRESS, cancel). */
  async changeStatus(ctx: RequestContext, id: number, dto: ChangeStatusDto): Promise<Fat> {
    const existing = await this.getById(ctx, id);
    if (dto.status === DISPATCH_CLEARANCE_STATUS) {
      throw Errors.conflict('Use /approve to sign off and clear a FAT for Dispatch');
    }
    if (!canTransition(existing.status, dto.status)) {
      throw Errors.conflict(`Invalid status transition: ${existing.status} -> ${dto.status}`);
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, dto.status);
    if (!updated) throw Errors.conflict('FAT was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Customer/QC sign-off (FAT.APPROVE): a PASSED FAT becomes CLEARED — the
   * Dispatch-clearance state. Emits the 'fat.passed' domain event atomically so
   * Dispatch (M11) can open its gate. A FAT with open punch items / no PASS
   * result cannot be cleared.
   */
  async approve(ctx: RequestContext, id: number, dto: ApproveDto): Promise<Fat> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'PASSED') {
      throw Errors.conflict(`Only a PASSED FAT can be signed off / cleared (current: ${existing.status})`);
    }
    if (existing.result !== 'PASS') {
      throw Errors.conflict('A FAT must have a PASS result before it can be cleared for Dispatch');
    }
    const openPunch = existing.punchItems.filter((p) => p.status === 'OPEN');
    if (openPunch.length > 0) {
      throw Errors.conflict(`Cannot clear a FAT with ${openPunch.length} open punch item(s)`);
    }
    const updated = await this.repo.updateStatus(
      ctx, id, dto.rowVersion, DISPATCH_CLEARANCE_STATUS,
      { signoff_by: ctx.userId, customer_witness: dto.customerWitness ?? existing.customerWitness },
      {
        eventType: FAT_PASSED_EVENT, aggregateType: 'FAT', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: { projectId: existing.projectId, fatNo: existing.fatNo },
      },
    );
    if (!updated) throw Errors.conflict('FAT was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'SCHEDULED') {
      throw Errors.conflict(`Only a SCHEDULED FAT can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** FAT.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['FAT No', 'Project', 'Protocol', 'FAT Date', 'Status', 'Result', 'Witness', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.fatNo, r.projectId, r.protocolId, r.fatDate, r.status, r.result, r.customerWitness, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
