import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  ContractRepository, ContractHeaderInput, MilestoneInput,
} from './contract.repository';
import { Contract, ContractListResult, ContractMilestone } from './contract.types';
import {
  CreateContractDto, UpdateContractDto, CancelDto, ListQueryDto,
} from './contract.dto';
import {
  canTransition, canTransitionMilestone, MilestoneStatus, CONTRACT_ACTIVATED_EVENT,
} from './contract.constants';

/** Money is stored as numeric(20,4); round to 4 dp to dodge float drift. */
const SCALE = 10_000;
function round4(n: number): number {
  return Math.round(n * SCALE) / SCALE;
}

/**
 * ContractService — business logic for the commercial customer-contract module.
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. Lifecycle DRAFT -> ACTIVE -> CLOSED (+ CANCELLED). ACTIVATE
 * is the binding step: it enforces Segregation of Duties (the activator, who holds
 * CONTRACT.APPROVE, must differ from the creator) and emits 'contract.activated'
 * atomically so billing / project consumers react downstream.
 */
export class ContractService {
  constructor(private readonly repo: ContractRepository) {}

  /** Resolve the currency to use: the supplied id, else the company's INR. */
  private async resolveCurrency(ctx: RequestContext, supplied?: number): Promise<number> {
    if (supplied != null) return supplied;
    const inr = await this.repo.resolveInrCurrencyId(ctx);
    if (inr == null) throw Errors.badRequest('No currency supplied and INR is not configured');
    return inr;
  }

  /**
   * Map DTO milestones to persistable inputs, deriving the absolute amount from
   * the milestone pct + contract value when only a pct is supplied (an explicit
   * amount always wins). A milestone with neither is recorded at amount 0.
   */
  private mapMilestones(dto: CreateContractDto['milestones'], contractValue: number): MilestoneInput[] {
    return (dto ?? []).map((m) => {
      const amount = m.amount != null
        ? round4(m.amount)
        : (m.milestonePct != null ? round4(contractValue * m.milestonePct / 100) : 0);
      return {
        name: m.name,
        milestonePct: m.milestonePct,
        amount,
        dueDate: m.dueDate,
        sortOrder: m.sortOrder,
      };
    });
  }

  async create(ctx: RequestContext, dto: CreateContractDto): Promise<Contract> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a contract number');
    }
    const currencyId = await this.resolveCurrency(ctx, dto.currencyId);
    const header: ContractHeaderInput = {
      customerId: dto.customerId,
      projectId: dto.projectId,
      title: dto.title,
      contractValue: round4(dto.contractValue),
      currencyId,
      paymentTerms: dto.paymentTerms,
      ldPenaltyPct: dto.ldPenaltyPct ?? 0,
      ldCapPct: dto.ldCapPct ?? 0,
      warrantyMonths: dto.warrantyMonths ?? 0,
      startDate: dto.startDate,
      endDate: dto.endDate,
      signedDate: dto.signedDate,
    };
    return this.repo.create(ctx, header, this.mapMilestones(dto.milestones, header.contractValue));
  }

  async getById(ctx: RequestContext, id: number): Promise<Contract> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Contract ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<ContractListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateContractDto): Promise<Contract> {
    const { rowVersion, milestones, ...rest } = dto;
    if (Object.keys(rest).length === 0 && !milestones) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT contract can be edited (current: ${existing.status})`);
    }
    // Carry forward unchanged header fields so a partial PATCH doesn't null them.
    const contractValue = rest.contractValue != null ? round4(rest.contractValue) : existing.contractValue;
    const currencyId = rest.currencyId ?? existing.currencyId
      ?? await this.resolveCurrency(ctx, undefined);
    const header: ContractHeaderInput = {
      customerId: existing.customerId,
      projectId: rest.projectId ?? existing.projectId ?? undefined,
      title: rest.title ?? existing.title ?? undefined,
      contractValue,
      currencyId,
      paymentTerms: rest.paymentTerms ?? existing.paymentTerms ?? undefined,
      ldPenaltyPct: rest.ldPenaltyPct ?? existing.ldPenaltyPct,
      ldCapPct: rest.ldCapPct ?? existing.ldCapPct,
      warrantyMonths: rest.warrantyMonths ?? existing.warrantyMonths,
      startDate: rest.startDate ?? existing.startDate ?? undefined,
      endDate: rest.endDate ?? existing.endDate ?? undefined,
      signedDate: rest.signedDate ?? existing.signedDate ?? undefined,
    };
    const updated = await this.repo.update(
      ctx, id, rowVersion, header,
      milestones ? this.mapMilestones(milestones, contractValue) : undefined,
    );
    if (!updated) {
      throw Errors.conflict('Contract was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Activate a DRAFT contract (DRAFT -> ACTIVE) — the binding commercial step.
   * Enforces Segregation of Duties: the activator (who holds CONTRACT.APPROVE)
   * must differ from the creator (else 403). Emits 'contract.activated' atomically
   * with the state change so billing / project consumers react downstream.
   */
  async activate(ctx: RequestContext, id: number, rowVersion: number): Promise<Contract> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'ACTIVE')) {
      throw Errors.conflict(`Only a DRAFT contract can be activated (current: ${existing.status})`);
    }
    if (existing.createdBy != null && existing.createdBy === ctx.userId) {
      throw Errors.forbidden('Segregation of Duties: you cannot activate a contract you created');
    }
    const updated = await this.repo.updateStatus(
      ctx, id, rowVersion, 'ACTIVE',
      {
        eventType: CONTRACT_ACTIVATED_EVENT, aggregateType: 'CONTRACT', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: {
          contractNo: existing.contractNo,
          customerId: existing.customerId,
          projectId: existing.projectId,
          contractValue: existing.contractValue,
        },
      },
    );
    if (!updated) throw Errors.conflict('Contract was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Close an ACTIVE contract (ACTIVE -> CLOSED) at the end of its obligations. */
  async close(ctx: RequestContext, id: number, rowVersion: number): Promise<Contract> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CLOSED')) {
      throw Errors.conflict(`Only an ACTIVE contract can be closed (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'CLOSED');
    if (!updated) throw Errors.conflict('Contract was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Cancel a DRAFT or ACTIVE contract with a reason. */
  async cancel(ctx: RequestContext, id: number, dto: CancelDto): Promise<Contract> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CANCELLED')) {
      throw Errors.conflict(`Cannot cancel a contract in status ${existing.status}`);
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'CANCELLED');
    if (!updated) throw Errors.conflict('Contract was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Mark a billing milestone INVOICED (PENDING -> INVOICED). */
  markMilestoneInvoiced(ctx: RequestContext, id: number, milestoneId: number): Promise<Contract> {
    return this.transitionMilestone(ctx, id, milestoneId, 'INVOICED');
  }

  /** Mark a billing milestone PAID (INVOICED -> PAID). */
  markMilestonePaid(ctx: RequestContext, id: number, milestoneId: number): Promise<Contract> {
    return this.transitionMilestone(ctx, id, milestoneId, 'PAID');
  }

  private async transitionMilestone(
    ctx: RequestContext, id: number, milestoneId: number, to: MilestoneStatus,
  ): Promise<Contract> {
    const existing = await this.getById(ctx, id); // 404 if the contract is missing
    const milestone: ContractMilestone | undefined =
      existing.milestones.find((m) => m.milestoneId === milestoneId);
    if (!milestone) throw Errors.notFound(`Milestone ${milestoneId} not found on contract ${id}`);
    if (!canTransitionMilestone(milestone.status, to)) {
      throw Errors.conflict(
        `Cannot move milestone from ${milestone.status} to ${to}`);
    }
    const updated = await this.repo.setMilestoneStatus(ctx, id, milestoneId, to);
    if (!updated) throw Errors.conflict('Contract was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT contract can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** CONTRACT.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = [
      'Contract No', 'Customer', 'Project', 'Title', 'Contract Value', 'Status',
      'Start Date', 'End Date', 'Warranty Months', 'Created',
    ];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.contractNo, r.customerId, r.projectId, r.title, r.contractValue, r.status,
      r.startDate, r.endDate, r.warrantyMonths, r.createdAt,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
