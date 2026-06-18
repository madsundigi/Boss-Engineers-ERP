import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { OutboxEventInput } from '../../outbox/outbox';
import { EnquiryRepository } from './enquiry.repository';
import { Enquiry, EnquiryListResult } from './enquiry.types';
import { CreateEnquiryDto, UpdateEnquiryDto, ChangeStatusDto, ListQueryDto } from './enquiry.dto';
import { canTransition } from './enquiry.constants';

/**
 * EnquiryService — business logic for the Customer Enquiry module.
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database.
 */
export class EnquiryService {
  constructor(private readonly repo: EnquiryRepository) {}

  async create(ctx: RequestContext, dto: CreateEnquiryDto): Promise<Enquiry> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate an enquiry number');
    }
    return this.repo.create(ctx, dto);
  }

  async getById(ctx: RequestContext, id: number): Promise<Enquiry> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Enquiry ${id} not found`);
    return row;
  }

  async list(ctx: RequestContext, query: ListQueryDto): Promise<EnquiryListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateEnquiryDto): Promise<Enquiry> {
    const { rowVersion, ...fields } = dto;
    if (Object.keys(fields).length === 0) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status === 'WON' || existing.status === 'LOST') {
      throw Errors.conflict(`Cannot edit an enquiry in status ${existing.status}`);
    }
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) {
      throw Errors.conflict('Enquiry was modified by someone else (row version mismatch)', {
        expected: rowVersion,
        current: existing.rowVersion,
      });
    }
    return updated;
  }

  async changeStatus(ctx: RequestContext, id: number, dto: ChangeStatusDto): Promise<Enquiry> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, dto.status)) {
      throw Errors.conflict(`Invalid status transition: ${existing.status} -> ${dto.status}`);
    }
    if (dto.status === 'LOST' && !dto.reason) {
      throw Errors.badRequest('A reason is required when marking an enquiry LOST');
    }
    // Winning the enquiry auto-seeds a Project (FRD §5). Emit 'enquiry.won' in the
    // SAME transaction as the status UPDATE so the project seed can never diverge
    // from a state change that didn't persist (transactional outbox).
    const event: OutboxEventInput | undefined =
      dto.status === 'WON'
        ? {
            eventType: 'enquiry.won', aggregateType: 'ENQUIRY', aggregateId: id,
            companyId: ctx.companyId, createdBy: ctx.userId, payload: { enquiryId: id },
          }
        : undefined;
    const updated = await this.repo.changeStatus(ctx, id, dto.rowVersion, dto.status, null, event);
    if (!updated) {
      throw Errors.conflict('Enquiry was modified by someone else (row version mismatch)');
    }
    return updated;
  }

  /** Qualification sign-off (ENQUIRY.APPROVE): NEW -> QUALIFIED. */
  async approve(ctx: RequestContext, id: number, rowVersion: number): Promise<Enquiry> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'NEW') {
      throw Errors.conflict(`Only a NEW enquiry can be qualified (current: ${existing.status})`);
    }
    const updated = await this.repo.changeStatus(ctx, id, rowVersion, 'QUALIFIED', null);
    if (!updated) throw Errors.conflict('Row version mismatch');
    return updated;
  }

  /**
   * Assign (or re-assign) the lead to a salesperson (ENQUIRY.EDIT). Validates the
   * target user is active first (400 if not), then optimistic-locks the update when
   * a rowVersion is supplied (409 on mismatch). 404 if the enquiry is missing.
   */
  async assign(ctx: RequestContext, id: number, userId: number, rowVersion?: number): Promise<Enquiry> {
    const existing = await this.getById(ctx, id); // 404 if missing
    const active = await this.repo.userIsActive(ctx, userId);
    if (!active) {
      throw Errors.badRequest(`User ${userId} is not an active user`);
    }
    const updated = await this.repo.assign(ctx, id, userId, rowVersion);
    if (!updated) {
      throw Errors.conflict('Enquiry was modified by someone else (row version mismatch)', {
        expected: rowVersion,
        current: existing.rowVersion,
      });
    }
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'NEW') {
      throw Errors.conflict(`Only a NEW (draft) enquiry can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** ENQUIRY.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Enquiry No', 'Customer Name', 'Contact', 'Email', 'Industry', 'Source', 'Status', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.enquiryNo, r.customerName, r.contact, r.email, r.industry, r.source, r.status, r.createdAt].map(esc).join(','),
    );
    return [head.join(','), ...lines].join('\n');
  }
}
