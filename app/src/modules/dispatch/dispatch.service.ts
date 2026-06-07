import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { DispatchRepository, DispatchHeaderInput, StatusPatch } from './dispatch.repository';
import { Dispatch, DispatchListResult, DispatchSerial, PackingLine } from './dispatch.types';
import {
  CreateDispatchDto, UpdateDispatchDto, ClearDto, CancelDto, ListQueryDto,
} from './dispatch.dto';
import {
  canTransition, DispatchStatus, DISPATCH_RELEASED_EVENT,
} from './dispatch.constants';

/** A status that no longer permits header edits / gate clearance. */
const NON_DRAFT_LOCKED: DispatchStatus[] = ['RELEASED', 'DELIVERED', 'CANCELLED'];

/** True once BOTH the quality and commercial clearance gates are open. */
export function bothGatesCleared(d: Pick<Dispatch, 'qualityClearedBy' | 'commercialClearedBy'>): boolean {
  return d.qualityClearedBy != null && d.commercialClearedBy != null;
}

/**
 * DispatchService — business logic for the Dispatch module (M11).
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. Enforces the multi-gate release: a dispatch can only be
 * RELEASED once BOTH the QC (quality) and Finance (commercial/payment) gates are
 * cleared. RELEASE emits 'dispatch.released' (warranty start + billing downstream).
 */
export class DispatchService {
  constructor(private readonly repo: DispatchRepository) {}

  private mapSerials(dto?: CreateDispatchDto['serials']): DispatchSerial[] {
    return (dto ?? []).map((s) => ({ itemId: s.itemId, serialId: s.serialId ?? null, qty: s.qty }));
  }
  private mapPacking(dto?: CreateDispatchDto['packingLines']): PackingLine[] {
    return (dto ?? []).map((p) => ({
      packageNo: p.packageNo, grossWeight: p.grossWeight ?? null, dimensions: p.dimensions ?? null,
    }));
  }

  async create(ctx: RequestContext, dto: CreateDispatchDto): Promise<Dispatch> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a dispatch number');
    }
    const header: DispatchHeaderInput = {
      projectId: dto.projectId, customerId: dto.customerId, fatId: dto.fatId,
      shipToAddressId: dto.shipToAddressId, dispatchDate: dto.dispatchDate,
      transporter: dto.transporter, lrNo: dto.lrNo, ewayBillNo: dto.ewayBillNo,
    };
    return this.repo.create(ctx, header, this.mapSerials(dto.serials), this.mapPacking(dto.packingLines));
  }

  async getById(ctx: RequestContext, id: number): Promise<Dispatch> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Dispatch ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<DispatchListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateDispatchDto): Promise<Dispatch> {
    const { rowVersion, serials, packingLines, ...rest } = dto;
    const fields = rest as Partial<DispatchHeaderInput>;
    if (Object.keys(fields).length === 0 && !serials && !packingLines) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT dispatch can be edited (current: ${existing.status})`);
    }
    const updated = await this.repo.update(
      ctx, id, rowVersion, fields,
      serials ? this.mapSerials(serials) : undefined,
      packingLines ? this.mapPacking(packingLines) : undefined,
    );
    if (!updated) {
      throw Errors.conflict('Dispatch was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Quality clearance gate (DISPATCH.APPROVE, intended for QC). Stamps the
   * quality_cleared_* columns on a DRAFT dispatch. Idempotent on a re-clear
   * (re-stamps the actor/time). Does not by itself release — both gates are
   * required (see release()).
   */
  async clearQuality(ctx: RequestContext, id: number, dto: ClearDto): Promise<Dispatch> {
    return this.clearGate(ctx, id, dto, {
      quality_cleared_by: ctx.userId, quality_cleared_at: new Date(),
    });
  }

  /**
   * Commercial / payment clearance gate (DISPATCH.APPROVE, intended for Finance).
   * Stamps the commercial_cleared_* columns on a DRAFT dispatch. The classic ETO
   * control: never release before the payment milestone is secured.
   */
  async clearCommercial(ctx: RequestContext, id: number, dto: ClearDto): Promise<Dispatch> {
    return this.clearGate(ctx, id, dto, {
      commercial_cleared_by: ctx.userId, commercial_cleared_at: new Date(),
    });
  }

  private async clearGate(ctx: RequestContext, id: number, dto: ClearDto, patch: StatusPatch): Promise<Dispatch> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Clearances can only be applied to a DRAFT dispatch (current: ${existing.status})`);
    }
    const updated = await this.repo.setGate(ctx, id, dto.rowVersion, patch);
    if (!updated) throw Errors.conflict('Dispatch was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Release the dispatch — only allowed once BOTH the quality and commercial
   * gates are cleared (else 409). Emits 'dispatch.released' atomically with the
   * state change so warranty start + billing milestone fire downstream.
   */
  async release(ctx: RequestContext, id: number, rowVersion: number): Promise<Dispatch> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'RELEASED')) {
      throw Errors.conflict(`Only a DRAFT dispatch can be released (current: ${existing.status})`);
    }
    if (!bothGatesCleared(existing)) {
      const missing: string[] = [];
      if (existing.qualityClearedBy == null) missing.push('quality (QC)');
      if (existing.commercialClearedBy == null) missing.push('commercial (Finance)');
      throw Errors.conflict(`Both clearance gates are required before release; missing: ${missing.join(' + ')}`);
    }
    const updated = await this.repo.updateStatus(
      ctx, id, rowVersion, 'RELEASED', {},
      {
        eventType: DISPATCH_RELEASED_EVENT, aggregateType: 'DISPATCH', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: {
          projectId: existing.projectId,
          dispatchNo: existing.dispatchNo,
          serials: existing.serials.map((s) => ({ itemId: s.itemId, serialId: s.serialId, qty: s.qty })),
        },
      },
    );
    if (!updated) throw Errors.conflict('Dispatch was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Mark a RELEASED dispatch as DELIVERED (proof of delivery). */
  async markDelivered(ctx: RequestContext, id: number, rowVersion: number): Promise<Dispatch> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'DELIVERED')) {
      throw Errors.conflict(`Only a RELEASED dispatch can be delivered (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'DELIVERED');
    if (!updated) throw Errors.conflict('Dispatch was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Cancel a DRAFT or RELEASED dispatch with a reason. */
  async cancel(ctx: RequestContext, id: number, dto: CancelDto): Promise<Dispatch> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CANCELLED')) {
      throw Errors.conflict(`Cannot cancel a dispatch in status ${existing.status}`);
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'CANCELLED');
    if (!updated) throw Errors.conflict('Dispatch was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT dispatch can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** DISPATCH.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Dispatch No', 'Project', 'Customer', 'Dispatch Date', 'Status', 'Transporter', 'LR No', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.dispatchNo, r.projectId, r.customerId, r.dispatchDate, r.status, r.transporter, r.lrNo, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
