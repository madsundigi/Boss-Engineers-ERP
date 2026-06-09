import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { ProductionRepository, CreateWorkOrderRow, HeaderFields, ConfirmationInput, StatusPatch } from './production.repository';
import { WorkOrder, WorkOrderListResult } from './production.types';
import {
  CreateWorkOrderDto, UpdateWorkOrderDto, ReleaseDto, ConfirmDto, CompleteDto,
  ChangeStatusDto, ListQueryDto,
} from './production.dto';
import {
  canTransition, isEditable, isTerminal, WO_RELEASED_EVENT, WO_COMPLETED_EVENT,
} from './production.constants';

/** Statuses during which production may be confirmed against an operation. */
const CONFIRMABLE = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const;

/**
 * ProductionService — business logic for the Work Order module (M08).
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. A work order is the costing + execution spine on the shop
 * floor: it is pegged to a project, released only when material is ready (and by
 * a WORK_ORDER.APPROVE holder), confirmed as production happens, and completed
 * with its as-built serials for traceability.
 */
export class ProductionService {
  constructor(private readonly repo: ProductionRepository) {}

  async create(ctx: RequestContext, dto: CreateWorkOrderDto): Promise<WorkOrder> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a work-order number');
    }
    const data: CreateWorkOrderRow = {
      projectId: dto.projectId,
      itemId: dto.itemId,
      qty: dto.qty,
      wbsId: dto.wbsId,
      bomId: dto.bomId,
      routingId: dto.routingId,
      plannedStart: dto.plannedStart,
      plannedEnd: dto.plannedEnd,
      delayReason: dto.delayReason,
      percentComplete: dto.percentComplete,
      operations: dto.operations?.map((o) => ({
        opSeq: o.opSeq, workCenterId: o.workCenterId, stdTimeMin: o.stdTimeMin,
      })),
      materials: dto.materials?.map((m) => ({ itemId: m.itemId, requiredQty: m.requiredQty })),
    };
    return this.repo.create(ctx, data, {
      eventType: 'workorder.created', aggregateType: 'WORK_ORDER',
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: { projectId: dto.projectId, itemId: dto.itemId, qty: dto.qty },
    });
  }

  async getById(ctx: RequestContext, id: number): Promise<WorkOrder> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Work order ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<WorkOrderListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateWorkOrderDto): Promise<WorkOrder> {
    const { rowVersion, operations, materials, ...fields } = dto;
    if (Object.keys(fields).length === 0 && operations === undefined && materials === undefined) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (!isEditable(existing.status)) {
      throw Errors.conflict(`Cannot edit the plan of a work order in status ${existing.status} (only PLANNED is editable)`);
    }
    const headerFields: HeaderFields = fields;
    const ops = operations?.map((o) => ({
      opSeq: o.opSeq, workCenterId: o.workCenterId, stdTimeMin: o.stdTimeMin,
    }));
    const mats = materials?.map((m) => ({ itemId: m.itemId, requiredQty: m.requiredQty }));
    const updated = await this.repo.update(ctx, id, rowVersion, headerFields, ops, mats);
    if (!updated) {
      throw Errors.conflict('Work order was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Release to the shop floor (WORK_ORDER.APPROVE): a PLANNED work order becomes
   * RELEASED. Blocked (409) unless material is ready — a simple readiness gate
   * the planner/stores assert. Emits the 'workorder.released' domain event
   * atomically with the state change.
   */
  async release(ctx: RequestContext, id: number, dto: ReleaseDto): Promise<WorkOrder> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'PLANNED') {
      throw Errors.conflict(`Only a PLANNED work order can be released (current: ${existing.status})`);
    }
    if (!dto.materialReady) {
      throw Errors.conflict('Cannot release: material is not ready for this work order');
    }
    const updated = await this.repo.updateStatus(
      ctx, id, dto.rowVersion, 'RELEASED',
      dto.plannedStart ? { planned_start: dto.plannedStart } : {},
      {
        eventType: WO_RELEASED_EVENT, aggregateType: 'WORK_ORDER', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: { projectId: existing.projectId, woNo: existing.woNo },
      });
    if (!updated) throw Errors.conflict('Work order was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Record production against an operation (WORK_ORDER.EDIT): produced / scrap /
   * rework quantities + actual hours. Only valid once the WO is RELEASED (moves
   * it to IN_PROGRESS on the first confirmation). The operation must belong to
   * this work order.
   */
  async confirm(ctx: RequestContext, id: number, dto: ConfirmDto): Promise<WorkOrder> {
    const existing = await this.getById(ctx, id);
    if (!CONFIRMABLE.includes(existing.status as (typeof CONFIRMABLE)[number])) {
      throw Errors.conflict(`Production can only be confirmed for a RELEASED/IN_PROGRESS work order (current: ${existing.status})`);
    }
    if (dto.producedQty === 0 && dto.scrapQty === 0 && dto.reworkQty === 0) {
      throw Errors.badRequest('A confirmation must record some produced, scrap, or rework quantity');
    }
    const belongs = existing.operations.some((o) => o.woOpId === dto.woOpId);
    if (!belongs) {
      throw Errors.badRequest(`Operation ${dto.woOpId} does not belong to work order ${id}`);
    }
    const conf: ConfirmationInput = {
      woOpId: dto.woOpId,
      qtyDone: dto.producedQty,
      qtyScrap: dto.scrapQty,
      qtyRework: dto.reworkQty,
      labourHours: dto.actualHours,
      confDate: dto.confDate,
      operationDone: dto.operationDone,
    };
    const updated = await this.repo.confirm(ctx, id, existing.rowVersion, conf);
    if (!updated) throw Errors.conflict('Work order was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Complete the work order (WORK_ORDER.EDIT) with its as-built serials: only an
   * IN_PROGRESS WO can be completed. For a serialized item the as-built list
   * provides the unit serials (traceability genealogy). Emits 'workorder.completed'.
   */
  async complete(ctx: RequestContext, id: number, dto: CompleteDto): Promise<WorkOrder> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'IN_PROGRESS') {
      throw Errors.conflict(`Only an IN_PROGRESS work order can be completed (current: ${existing.status})`);
    }
    const asBuilt = (dto.asBuilt ?? []).map((b) => ({
      serialNo: b.serialNo, parentSerialNo: b.parentSerialNo,
    }));
    const updated = await this.repo.complete(
      ctx, id, dto.rowVersion, existing.itemId, existing.projectId, asBuilt,
      {
        eventType: WO_COMPLETED_EVENT, aggregateType: 'WORK_ORDER', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: { projectId: existing.projectId, woNo: existing.woNo, serials: asBuilt.length },
      });
    if (!updated) throw Errors.conflict('Work order was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Guarded lifecycle transition (hold / resume / cancel). Release + complete have own endpoints. */
  async changeStatus(ctx: RequestContext, id: number, dto: ChangeStatusDto): Promise<WorkOrder> {
    const existing = await this.getById(ctx, id);
    if (dto.status === 'RELEASED') {
      throw Errors.conflict('Use /release to release a work order (material + approval gate)');
    }
    if (dto.status === 'COMPLETED') {
      throw Errors.conflict('Use /complete to finish a work order (records as-built serials)');
    }
    if (isTerminal(existing.status)) {
      throw Errors.conflict(`Work order is ${existing.status} (terminal) and cannot transition`);
    }
    if (!canTransition(existing.status, dto.status)) {
      throw Errors.conflict(`Invalid status transition: ${existing.status} -> ${dto.status}`);
    }
    if (dto.status === 'CANCELLED' && !dto.reason) {
      throw Errors.badRequest('A reason is required when cancelling a work order');
    }
    // Capture in-flight progress metrics alongside the transition (e.g. delay reason on hold).
    const patch: StatusPatch = {};
    if (dto.delayReason !== undefined) patch.delay_reason = dto.delayReason;
    if (dto.percentComplete !== undefined) patch.percent_complete = dto.percentComplete;
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, dto.status, patch);
    if (!updated) throw Errors.conflict('Work order was modified by someone else (row version mismatch)');
    return updated;
  }

  /** WORK_ORDER.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['WO No', 'Project', 'Item', 'Qty', 'Status', 'Planned Start', 'Planned End', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.woNo, r.projectId, r.itemId, r.qty, r.status, r.plannedStart, r.plannedEnd, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
