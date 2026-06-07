import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { ChangeOrderRepository, ChangeOrderInput } from './change.repository';
import { ChangeOrder, ChangeOrderListResult } from './change.types';
import {
  CreateChangeOrderDto, UpdateChangeOrderDto, RejectDto, ListQueryDto,
} from './change.dto';
import { canTransition, CHANGE_ORDER_APPROVED_EVENT } from './change.constants';

/**
 * ChangeOrderService — business logic for Change / Variation Management.
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. A change order formally re-costs / re-baselines a project:
 *   DRAFT -> SUBMITTED -> APPROVED | REJECTED -> IMPLEMENTED  (+ CANCELLED)
 * APPROVE enforces Segregation of Duties (the approver must differ from the
 * creator) and emits 'change_order.approved' so Profitability / Planning re-cost
 * and re-baseline from the cost / price impact.
 */
export class ChangeOrderService {
  constructor(private readonly repo: ChangeOrderRepository) {}

  async create(ctx: RequestContext, dto: CreateChangeOrderDto): Promise<ChangeOrder> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a change-order number');
    }
    const input: ChangeOrderInput = {
      projectId: dto.projectId, description: dto.description, reason: dto.reason,
      costImpact: dto.costImpact, priceImpact: dto.priceImpact,
      scheduleImpactDays: dto.scheduleImpactDays,
    };
    return this.repo.create(ctx, input);
  }

  async getById(ctx: RequestContext, id: number): Promise<ChangeOrder> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Change order ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<ChangeOrderListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateChangeOrderDto): Promise<ChangeOrder> {
    const { rowVersion, ...rest } = dto;
    const fields = rest as Partial<ChangeOrderInput>;
    if (Object.keys(fields).length === 0) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT change order can be edited (current: ${existing.status})`);
    }
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) {
      throw Errors.conflict('Change order was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /** Submit a DRAFT change order for approval (DRAFT -> SUBMITTED). */
  async submit(ctx: RequestContext, id: number, rowVersion: number): Promise<ChangeOrder> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'SUBMITTED')) {
      throw Errors.conflict(`Only a DRAFT change order can be submitted (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'SUBMITTED');
    if (!updated) throw Errors.conflict('Change order was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Approve a SUBMITTED change order (SUBMITTED -> APPROVED). Enforces
   * Segregation of Duties: the approver must differ from the creator (else 403).
   * Emits 'change_order.approved' atomically with the state change so
   * Profitability / Planning re-cost and re-baseline the project downstream.
   */
  async approve(ctx: RequestContext, id: number, rowVersion: number): Promise<ChangeOrder> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'APPROVED')) {
      throw Errors.conflict(`Only a SUBMITTED change order can be approved (current: ${existing.status})`);
    }
    if (existing.createdBy != null && existing.createdBy === ctx.userId) {
      throw Errors.forbidden('Segregation of Duties: you cannot approve a change order you created');
    }
    const updated = await this.repo.updateStatus(
      ctx, id, rowVersion, 'APPROVED', {},
      {
        eventType: CHANGE_ORDER_APPROVED_EVENT, aggregateType: 'CHANGE_ORDER', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: {
          changeNo: existing.changeNo,
          projectId: existing.projectId,
          costImpact: existing.costImpact,
          priceImpact: existing.priceImpact,
        },
      },
    );
    if (!updated) throw Errors.conflict('Change order was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Reject a SUBMITTED change order with a reason (SUBMITTED -> REJECTED). */
  async reject(ctx: RequestContext, id: number, dto: RejectDto): Promise<ChangeOrder> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'REJECTED')) {
      throw Errors.conflict(`Only a SUBMITTED change order can be rejected (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'REJECTED', { reason: dto.reason });
    if (!updated) throw Errors.conflict('Change order was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Mark an APPROVED change order as IMPLEMENTED (the re-baseline is applied). */
  async markImplemented(ctx: RequestContext, id: number, rowVersion: number): Promise<ChangeOrder> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'IMPLEMENTED')) {
      throw Errors.conflict(`Only an APPROVED change order can be implemented (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'IMPLEMENTED');
    if (!updated) throw Errors.conflict('Change order was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Cancel a non-terminal change order. */
  async cancel(ctx: RequestContext, id: number, rowVersion: number): Promise<ChangeOrder> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CANCELLED')) {
      throw Errors.conflict(`Cannot cancel a change order in status ${existing.status}`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'CANCELLED');
    if (!updated) throw Errors.conflict('Change order was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT change order can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** CHANGE_ORDER.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Change No', 'Project', 'Description', 'Cost Impact', 'Price Impact', 'Schedule Days', 'Status', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.changeNo, r.projectId, r.description, r.costImpact, r.priceImpact, r.scheduleImpactDays, r.status, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
