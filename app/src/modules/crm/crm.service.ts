import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { CrmRepository, OpportunityInput, ActivityInput } from './crm.repository';
import {
  Opportunity, OpportunityListResult, PipelineStageSummary,
  Activity, ActivityListResult, Customer360,
} from './crm.types';
import {
  CreateOpportunityDto, UpdateOpportunityDto, AdvanceStageDto, LoseDto,
  ListOpportunityQueryDto, CreateActivityDto, ListActivityQueryDto,
} from './crm.dto';
import {
  canAdvance, TERMINAL_STAGES, OpportunityStage, OPPORTUNITY_WON_EVENT,
} from './crm.constants';

/** Money is stored as numeric(20,4); round to 4 dp to dodge float drift. */
const SCALE = 10_000;
function round4(n: number): number {
  return Math.round(n * SCALE) / SCALE;
}

/**
 * CrmService — business logic for the CRM module (sales opportunity pipeline +
 * follow-up activities + customer-360). Stateless; depends only on the injected
 * repository so it is unit-testable without a database. Pipeline
 * NEW -> QUALIFIED -> PROPOSAL -> NEGOTIATION -> WON | LOST; WON emits
 * 'opportunity.won' atomically so downstream consumers react.
 */
export class CrmService {
  constructor(private readonly repo: CrmRepository) {}

  // ---------------------------------------------------------------------------
  // Opportunity
  // ---------------------------------------------------------------------------

  async createOpportunity(ctx: RequestContext, dto: CreateOpportunityDto): Promise<Opportunity> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate an opportunity number');
    }
    const header: OpportunityInput = {
      customerId: dto.customerId,
      enquiryId: dto.enquiryId,
      title: dto.title,
      estValue: round4(dto.estValue ?? 0),
      probabilityPct: dto.probabilityPct ?? 0,
      expectedCloseDate: dto.expectedCloseDate,
      ownerId: dto.ownerId,
    };
    return this.repo.createOpportunity(ctx, header);
  }

  async getOpportunity(ctx: RequestContext, id: number): Promise<Opportunity> {
    const row = await this.repo.findOpportunity(ctx, id);
    if (!row) throw Errors.notFound(`Opportunity ${id} not found`);
    return row;
  }

  listOpportunities(ctx: RequestContext, query: ListOpportunityQueryDto): Promise<OpportunityListResult> {
    return this.repo.listOpportunities(ctx, query);
  }

  pipelineSummary(ctx: RequestContext, customerId?: number): Promise<PipelineStageSummary[]> {
    return this.repo.pipelineSummary(ctx, customerId);
  }

  async updateOpportunity(ctx: RequestContext, id: number, dto: UpdateOpportunityDto): Promise<Opportunity> {
    const { rowVersion, ...fields } = dto;
    const existing = await this.getOpportunity(ctx, id);
    if (TERMINAL_STAGES.includes(existing.stage)) {
      throw Errors.conflict(`Cannot edit a ${existing.stage} opportunity`);
    }
    if (fields.estValue != null) fields.estValue = round4(fields.estValue);
    const updated = await this.repo.updateOpportunity(ctx, id, rowVersion, fields);
    if (!updated) throw Errors.conflict('Opportunity was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Advance an opportunity forward to the given open stage (NEW -> QUALIFIED ->
   * PROPOSAL -> NEGOTIATION). Only forward moves are allowed; WON / LOST are reached
   * via win / lose, not here.
   */
  async advanceStage(ctx: RequestContext, id: number, dto: AdvanceStageDto): Promise<Opportunity> {
    const to = dto.stage as OpportunityStage;
    const existing = await this.getOpportunity(ctx, id);
    if (!canAdvance(existing.stage, to)) {
      throw Errors.conflict(`Cannot move an opportunity from ${existing.stage} to ${to}`);
    }
    const updated = await this.repo.setStage(ctx, id, dto.rowVersion, to);
    if (!updated) throw Errors.conflict('Opportunity was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Close-won (-> WON): emits 'opportunity.won' atomically with the stage change so
   * downstream consumers (quotation / project / CEO dashboard) react. Allowed from
   * any open (non-terminal) stage.
   */
  async win(ctx: RequestContext, id: number, rowVersion: number): Promise<Opportunity> {
    const existing = await this.getOpportunity(ctx, id);
    if (TERMINAL_STAGES.includes(existing.stage)) {
      throw Errors.conflict(`Opportunity is already ${existing.stage}`);
    }
    const updated = await this.repo.setStage(ctx, id, rowVersion, 'WON', {
      event: {
        eventType: OPPORTUNITY_WON_EVENT, aggregateType: 'OPPORTUNITY', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: { oppNo: existing.oppNo, customerId: existing.customerId, estValue: existing.estValue },
      },
    });
    if (!updated) throw Errors.conflict('Opportunity was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Close-lost (-> LOST) with a reason. Allowed from any open (non-terminal) stage. */
  async lose(ctx: RequestContext, id: number, dto: LoseDto): Promise<Opportunity> {
    const existing = await this.getOpportunity(ctx, id);
    if (TERMINAL_STAGES.includes(existing.stage)) {
      throw Errors.conflict(`Opportunity is already ${existing.stage}`);
    }
    const updated = await this.repo.setStage(ctx, id, dto.rowVersion, 'LOST', { lostReason: dto.lostReason });
    if (!updated) throw Errors.conflict('Opportunity was modified by someone else (row version mismatch)');
    return updated;
  }

  async deleteOpportunity(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    await this.getOpportunity(ctx, id); // 404 if missing
    const ok = await this.repo.softDeleteOpportunity(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Opportunity was modified by someone else (row version mismatch)');
  }

  /** CRM.EXPORT — CSV of the (filtered) opportunity list. */
  async exportCsv(ctx: RequestContext, query: ListOpportunityQueryDto): Promise<string> {
    const { rows } = await this.repo.listOpportunities(ctx, { ...query, page: 1, pageSize: 200 });
    const head = [
      'Opp No', 'Customer', 'Title', 'Stage', 'Est Value', 'Probability %',
      'Expected Close', 'Owner', 'Lost Reason', 'Created',
    ];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.oppNo, r.customerId, r.title, r.stage, r.estValue, r.probabilityPct,
      r.expectedCloseDate, r.ownerId, r.lostReason, r.createdAt,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }

  // ---------------------------------------------------------------------------
  // Activity
  // ---------------------------------------------------------------------------

  /** Log a follow-up activity. At least one of oppId / customerId must be supplied. */
  async createActivity(ctx: RequestContext, dto: CreateActivityDto): Promise<Activity> {
    if (dto.oppId == null && dto.customerId == null) {
      throw Errors.badRequest('An activity must be linked to an opportunity or a customer');
    }
    const input: ActivityInput = {
      oppId: dto.oppId,
      customerId: dto.customerId,
      activityType: dto.activityType,
      subject: dto.subject,
      dueDate: dto.dueDate,
      ownerId: dto.ownerId,
      notes: dto.notes,
    };
    return this.repo.createActivity(ctx, input);
  }

  async getActivity(ctx: RequestContext, id: number): Promise<Activity> {
    const row = await this.repo.findActivity(ctx, id);
    if (!row) throw Errors.notFound(`Activity ${id} not found`);
    return row;
  }

  listActivities(ctx: RequestContext, query: ListActivityQueryDto): Promise<ActivityListResult> {
    return this.repo.listActivities(ctx, query);
  }

  /** Mark an activity DONE (stamps completed_at). Rejects a non-PENDING activity. */
  async completeActivity(ctx: RequestContext, id: number, rowVersion: number): Promise<Activity> {
    const existing = await this.getActivity(ctx, id);
    if (existing.status !== 'PENDING') {
      throw Errors.conflict(`Only a PENDING activity can be completed (current: ${existing.status})`);
    }
    const updated = await this.repo.completeActivity(ctx, id, rowVersion);
    if (!updated) throw Errors.conflict('Activity was modified by someone else (row version mismatch)');
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Customer 360
  // ---------------------------------------------------------------------------

  customer360(ctx: RequestContext, customerId: number): Promise<Customer360> {
    return this.repo.customer360(ctx, customerId);
  }
}
