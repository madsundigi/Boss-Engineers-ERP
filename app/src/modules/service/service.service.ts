import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { ServiceRepository, TicketHeaderInput } from './service.repository';
import {
  ServiceTicket, ServiceTicketListResult, FieldVisit, SpareIssue, WarrantyClaim,
} from './service.types';
import {
  CreateTicketDto, UpdateTicketDto, AssignDto, ResolveDto, CancelDto,
  WarrantyClaimDto, ListQueryDto,
} from './service.dto';
import {
  canTransition, TERMINAL_STATUSES, ServiceTicketStatus,
  TICKET_RESOLVED_EVENT, WARRANTY_CLAIM_APPROVED_EVENT,
} from './service.constants';

/**
 * ServiceService — business logic for the Warranty & Service module (M13).
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. Drives the break-fix lifecycle
 *   OPEN -> ASSIGNED -> IN_PROGRESS -> RESOLVED -> CLOSED (+ CANCELLED)
 * and the warranty-claim validity / goodwill approval. RESOLVE emits
 * 'service_ticket.resolved' (failure analysis + warranty cost -> project P&L);
 * an approved claim emits 'warranty_claim.approved' (Finance cost / billing).
 */
export class ServiceService {
  constructor(private readonly repo: ServiceRepository) {}

  private mapVisits(dto?: CreateTicketDto['visits']): FieldVisit[] {
    return (dto ?? []).map((v) => ({
      engineerId: v.engineerId ?? null,
      visitDate: v.visitDate ?? new Date().toISOString().slice(0, 10),
      hours: v.hours ?? null,
      travelCost: v.travelCost ?? 0,
      notes: v.notes ?? null,
    }));
  }
  private mapSpares(dto?: CreateTicketDto['spares']): SpareIssue[] {
    return (dto ?? []).map((s) => ({
      itemId: s.itemId, qty: s.qty, unitCost: s.unitCost ?? 0, isChargeable: s.isChargeable ?? false,
    }));
  }

  async create(ctx: RequestContext, dto: CreateTicketDto): Promise<ServiceTicket> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a service-ticket number');
    }
    const header: TicketHeaderInput = {
      customerId: dto.customerId, serialId: dto.serialId, warrantyId: dto.warrantyId,
      contractId: dto.contractId, priority: dto.priority, isInWarranty: dto.isInWarranty,
      reportedAt: dto.reportedAt, slaDueAt: dto.slaDueAt,
    };
    return this.repo.create(ctx, header, this.mapVisits(dto.visits), this.mapSpares(dto.spares));
  }

  async getById(ctx: RequestContext, id: number): Promise<ServiceTicket> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Service ticket ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<ServiceTicketListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateTicketDto): Promise<ServiceTicket> {
    const { rowVersion, visits, spares, ...rest } = dto;
    const fields = rest as Partial<TicketHeaderInput>;
    if (Object.keys(fields).length === 0 && !visits && !spares) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (TERMINAL_STATUSES.includes(existing.status)) {
      throw Errors.conflict(`A ${existing.status} ticket can no longer be edited`);
    }
    const updated = await this.repo.update(
      ctx, id, rowVersion, fields,
      visits ? this.mapVisits(visits) : undefined,
      spares ? this.mapSpares(spares) : undefined,
    );
    if (!updated) {
      throw Errors.conflict('Service ticket was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /** Allocate a field engineer (OPEN/ASSIGNED -> ASSIGNED). */
  async assign(ctx: RequestContext, id: number, dto: AssignDto): Promise<ServiceTicket> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'ASSIGNED') && existing.status !== 'ASSIGNED') {
      throw Errors.conflict(`Cannot assign an engineer to a ${existing.status} ticket`);
    }
    const updated = await this.repo.assign(ctx, id, dto.rowVersion, dto.engineerId);
    if (!updated) throw Errors.conflict('Service ticket was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Begin work (OPEN/ASSIGNED -> IN_PROGRESS). */
  async startWork(ctx: RequestContext, id: number, rowVersion: number): Promise<ServiceTicket> {
    return this.transition(ctx, id, rowVersion, 'IN_PROGRESS');
  }

  /**
   * Resolve the fault: capture the resolution, move to RESOLVED, and emit
   * 'service_ticket.resolved' atomically (failure analysis + warranty cost to the
   * originating project's P&L downstream).
   */
  async resolve(ctx: RequestContext, id: number, dto: ResolveDto): Promise<ServiceTicket> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'RESOLVED')) {
      throw Errors.conflict(`A ${existing.status} ticket cannot be resolved`);
    }
    const updated = await this.repo.updateStatus(
      ctx, id, dto.rowVersion, 'RESOLVED', { resolution: dto.resolution },
      {
        eventType: TICKET_RESOLVED_EVENT, aggregateType: 'SERVICE_TICKET', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: {
          ticketNo: existing.ticketNo,
          customerId: existing.customerId,
          serialId: existing.serialId,
          isInWarranty: existing.isInWarranty,
          spares: existing.spares.map((s) => ({ itemId: s.itemId, qty: s.qty, unitCost: s.unitCost })),
        },
      },
    );
    if (!updated) throw Errors.conflict('Service ticket was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Customer-confirmed closure (RESOLVED -> CLOSED). */
  async close(ctx: RequestContext, id: number, rowVersion: number): Promise<ServiceTicket> {
    return this.transition(ctx, id, rowVersion, 'CLOSED');
  }

  /** Cancel a non-terminal ticket with a reason. */
  async cancel(ctx: RequestContext, id: number, dto: CancelDto): Promise<ServiceTicket> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CANCELLED')) {
      throw Errors.conflict(`Cannot cancel a ticket in status ${existing.status}`);
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'CANCELLED');
    if (!updated) throw Errors.conflict('Service ticket was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Shared lifecycle move with the transition guard + optimistic lock. */
  private async transition(
    ctx: RequestContext, id: number, rowVersion: number, to: ServiceTicketStatus,
  ): Promise<ServiceTicket> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, to)) {
      throw Errors.conflict(`Cannot move a ${existing.status} ticket to ${to}`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, to);
    if (!updated) throw Errors.conflict('Service ticket was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Warranty-claim validity / goodwill (concession) approval — SERVICE_TICKET.APPROVE.
   * Records the claim disposition against the ticket's warranty and, on APPROVED,
   * emits 'warranty_claim.approved' (Finance raises the warranty-cost / service
   * billing entry). A REJECTED disposition records the decision without the event.
   */
  async warrantyClaim(ctx: RequestContext, id: number, dto: WarrantyClaimDto): Promise<WarrantyClaim> {
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status === 'CANCELLED') {
      throw Errors.conflict('Cannot raise a warranty claim on a CANCELLED ticket');
    }
    const claimCost = dto.claimCost ?? 0;
    const approved = dto.decision === 'APPROVED';
    return this.repo.recordWarrantyClaim(
      ctx, id, dto.warrantyId, claimCost, dto.decision,
      approved
        ? {
          eventType: WARRANTY_CLAIM_APPROVED_EVENT, aggregateType: 'SERVICE_TICKET', aggregateId: id,
          companyId: ctx.companyId, createdBy: ctx.userId,
          payload: {
            ticketNo: existing.ticketNo,
            warrantyId: dto.warrantyId,
            claimCost,
            isGoodwill: dto.isGoodwill ?? false,
          },
        }
        : undefined,
    );
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'OPEN') {
      throw Errors.conflict(`Only an OPEN ticket can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** SERVICE_TICKET.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Ticket No', 'Customer', 'Priority', 'In Warranty', 'Status', 'Reported At', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.ticketNo, r.customerId, r.priority, r.isInWarranty, r.status, r.reportedAt, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
