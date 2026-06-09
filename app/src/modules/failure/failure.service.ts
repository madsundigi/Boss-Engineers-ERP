import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  FailureRepository, NcrHeaderInput, RcaInput, CapaInput, CapaActionInput,
} from './failure.repository';
import { Ncr, Capa, CapaAction, NcrListResult, ParetoReport, ParetoRow } from './failure.types';
import {
  CreateNcrDto, AddRcaDto, AddCapaDto, AddCapaActionDto, UpdateCapaStatusDto, ListQueryDto,
  ParetoQueryDto,
} from './failure.dto';
import { canTransition, CAPA_SETTLED, NCR_CLOSED_EVENT } from './failure.constants';

/**
 * FailureService — business logic for the Failure Analysis module (M14): the
 * quality nonconformance / 8D workflow NCR -> RCA -> CAPA -> CLOSED. Stateless;
 * depends only on the repository (injected) so it is unit-testable without a
 * database. An NCR advances to RCA once a root-cause analysis is recorded, to CAPA
 * once a corrective/preventive action is recorded, and can only be CLOSED from CAPA
 * once EVERY CAPA's effectiveness is verified (VERIFIED/CLOSED). CLOSE emits
 * 'ncr.closed' (closed-loop quality KPIs + failure-mode learning downstream).
 */
export class FailureService {
  constructor(private readonly repo: FailureRepository) {}

  async create(ctx: RequestContext, dto: CreateNcrDto): Promise<Ncr> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate an NCR number');
    }
    const header: NcrHeaderInput = {
      source: dto.source, sourceDocId: dto.sourceDocId, itemId: dto.itemId,
      projectId: dto.projectId, failureModeId: dto.failureModeId,
      severity: dto.severity, raisedDate: dto.raisedDate,
    };
    return this.repo.create(ctx, header);
  }

  async getById(ctx: RequestContext, id: number): Promise<Ncr> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`NCR ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<NcrListResult> {
    return this.repo.list(ctx, query);
  }

  /**
   * Pareto / repeat-failure report (read-only): take the repository's ordered raw
   * counts and fold in the share + a running cumulative share, plus the repeat flag.
   * Done in TS (not SQL) so the math stays trivially testable. total is the sum of
   * the buckets (each NCR counts once), so an empty company is { total: 0, rows: [] }
   * and percentages never divide by zero. NULL-keyed buckets surface as
   * 'Unclassified'. A bucket with count >= 2 is a recurring/repeat failure.
   */
  async pareto(ctx: RequestContext, dto: ParetoQueryDto): Promise<ParetoReport> {
    const counts = await this.repo.paretoCounts(ctx, dto);
    const total = counts.reduce((sum, r) => sum + r.count, 0);
    const round2 = (n: number) => Math.round(n * 100) / 100;

    let cumulative = 0;
    const rows: ParetoRow[] = counts.map((r) => {
      const pct = total === 0 ? 0 : round2((r.count / total) * 100);
      cumulative += r.count;
      const cumulativePct = total === 0 ? 0 : round2((cumulative / total) * 100);
      return {
        failureModeId: r.key,
        failureMode: r.key === null ? 'Unclassified' : r.label,
        count: r.count,
        pct,
        cumulativePct,
        isRepeat: r.count >= 2,
      };
    });
    return { by: dto.by, total, rows };
  }

  /**
   * Record a root-cause analysis. If the NCR is still OPEN, advance it to RCA
   * (the first analysis opens the analysis phase); a later analysis on an
   * already-advanced NCR is recorded without a status change.
   */
  async addRca(ctx: RequestContext, id: number, dto: AddRcaDto): Promise<Ncr> {
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status === 'CLOSED') {
      throw Errors.conflict('Cannot add a root-cause analysis to a CLOSED NCR');
    }
    const advanceTo = existing.status === 'OPEN' ? 'RCA' as const : undefined;
    const rca: RcaInput = { method: dto.method, rootCause: dto.rootCause, analysis: dto.analysis };
    const updated = await this.repo.addRca(ctx, id, dto.rowVersion, rca, advanceTo);
    if (!updated) {
      throw Errors.conflict('NCR was modified by someone else (row version mismatch)', {
        expected: dto.rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Record a corrective/preventive action. Requires a recorded root cause first
   * (must be at/after RCA), then advances the NCR to CAPA. A further action on an
   * NCR already in CAPA is recorded without a status change.
   */
  async addCapa(ctx: RequestContext, id: number, dto: AddCapaDto): Promise<Ncr> {
    const existing = await this.getById(ctx, id);
    if (existing.status === 'OPEN') {
      throw Errors.conflict('Record a root-cause analysis (RCA) before raising a CAPA');
    }
    if (existing.status === 'CLOSED') {
      throw Errors.conflict('Cannot add a CAPA to a CLOSED NCR');
    }
    const advanceTo = existing.status === 'RCA' ? 'CAPA' as const : undefined;
    const capa: CapaInput = {
      capaType: dto.capaType, action: dto.action, ownerId: dto.ownerId,
      dueDate: dto.dueDate, effectivenessCheck: dto.effectivenessCheck,
    };
    const updated = await this.repo.addCapa(ctx, id, dto.rowVersion, capa, advanceTo);
    if (!updated) {
      throw Errors.conflict('NCR was modified by someone else (row version mismatch)', {
        expected: dto.rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /** Add a step under a CAPA of the NCR (the NCR must be in the CAPA phase). */
  async addCapaAction(
    ctx: RequestContext, id: number, capaId: number, dto: AddCapaActionDto,
  ): Promise<CapaAction> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'CAPA') {
      throw Errors.conflict(`CAPA actions can only be added while the NCR is in CAPA (current: ${existing.status})`);
    }
    const input: CapaActionInput = {
      description: dto.description, ownerId: dto.ownerId, dueDate: dto.dueDate,
    };
    const action = await this.repo.addCapaAction(ctx, id, capaId, input);
    if (!action) throw Errors.notFound(`CAPA ${capaId} not found on NCR ${id}`);
    return action;
  }

  /** Advance a CAPA's status (e.g. -> VERIFIED once effectiveness is confirmed). */
  async updateCapaStatus(
    ctx: RequestContext, id: number, capaId: number, dto: UpdateCapaStatusDto,
  ): Promise<Capa> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'CAPA') {
      throw Errors.conflict(`A CAPA can only be progressed while the NCR is in CAPA (current: ${existing.status})`);
    }
    const updated = await this.repo.updateCapaStatus(ctx, id, capaId, dto.status, dto.effectivenessCheck);
    if (!updated) throw Errors.notFound(`CAPA ${capaId} not found on NCR ${id}`);
    return updated;
  }

  /**
   * Close the NCR (the verification gate). Only allowed from CAPA, and only when
   * EVERY CAPA on the NCR is settled (VERIFIED or CLOSED) — else 409. Emits
   * 'ncr.closed' atomically with the state change.
   */
  async close(ctx: RequestContext, id: number, rowVersion: number): Promise<Ncr> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CLOSED')) {
      throw Errors.conflict(`Only an NCR in CAPA can be closed (current: ${existing.status})`);
    }
    if (existing.capa.length === 0) {
      throw Errors.conflict('Cannot close an NCR with no CAPA recorded');
    }
    const unsettled = existing.capa.filter((c) => !CAPA_SETTLED.includes(c.status));
    if (unsettled.length > 0) {
      throw Errors.conflict('Every CAPA must be VERIFIED or CLOSED before the NCR can be closed', {
        unsettled: unsettled.map((c) => ({ capaId: c.capaId, status: c.status })),
      });
    }
    const updated = await this.repo.close(ctx, id, rowVersion, {
      eventType: NCR_CLOSED_EVENT, aggregateType: 'NCR', aggregateId: id,
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: {
        ncrNo: existing.ncrNo,
        source: existing.source,
        projectId: existing.projectId,
      },
    });
    if (!updated) {
      throw Errors.conflict('NCR was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'OPEN') {
      throw Errors.conflict(`Only an OPEN NCR can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** NCR_CAPA.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['NCR No', 'Source', 'Project', 'Severity', 'Status', 'Raised Date', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.ncrNo, r.source, r.projectId, r.severity, r.status, r.raisedDate, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
