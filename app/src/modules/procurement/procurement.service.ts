import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  ProcurementRepository, PrHeaderInput, PrLineInput, PoHeaderInput, PoLineInput, GrnLineInput,
} from './procurement.repository';
import { PurchaseRequisition, PurchaseOrder, GoodsReceipt } from './procurement.types';
import { CreatePrDto, CreatePoDto, ReceiveGrnDto, PrListQueryDto, PoListQueryDto, GrnListQueryDto } from './procurement.dto';
import { PO_APPROVED_EVENT, PO_AGGREGATE } from './procurement.constants';

/** PO approval committed cost surfaced to the caller for the commitment ledger. */
export interface PoApprovalResult { purchaseOrder: PurchaseOrder; committedCost: number; }

export class ProcurementService {
  constructor(private readonly repo: ProcurementRepository) {}

  // ---- Purchase Requisition ------------------------------------------------

  async createPr(ctx: RequestContext, dto: CreatePrDto): Promise<PurchaseRequisition> {
    if (!ctx.buId) throw Errors.badRequest('A branch (x-bu-id) is required to allocate a PR number');
    const header: PrHeaderInput = { projectId: dto.projectId, wbsId: dto.wbsId, requiredDate: dto.requiredDate };
    const lines: PrLineInput[] = dto.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, needByDate: l.needByDate }));
    return this.repo.createPr(ctx, header, lines);
  }

  async getPr(ctx: RequestContext, id: number): Promise<PurchaseRequisition> {
    const pr = await this.repo.findPr(ctx, id);
    if (!pr) throw Errors.notFound(`Purchase requisition ${id} not found`);
    return pr;
  }
  listPr(ctx: RequestContext, query: PrListQueryDto) { return this.repo.listPr(ctx, query); }

  /** DRAFT -> PENDING (submit for approval). */
  async submitPr(ctx: RequestContext, id: number, rowVersion: number): Promise<PurchaseRequisition> {
    const existing = await this.getPr(ctx, id);
    if (existing.status !== 'DRAFT') throw Errors.conflict(`Only a DRAFT PR can be submitted (status ${existing.status})`);
    const pr = await this.repo.updatePrStatus(ctx, id, rowVersion, 'PENDING');
    if (!pr) throw Errors.conflict('Purchase requisition was modified by someone else (row version mismatch)');
    return pr;
  }

  /** PENDING -> APPROVED. Route is gated by PURCHASE_REQ.APPROVE; SoD: creator != approver. */
  async approvePr(ctx: RequestContext, id: number, rowVersion: number): Promise<PurchaseRequisition> {
    const existing = await this.getPr(ctx, id);
    if (existing.createdBy === ctx.userId) {
      throw Errors.forbidden('Segregation of Duties: you cannot approve a purchase requisition you created');
    }
    if (existing.status !== 'PENDING') throw Errors.conflict(`Only a PENDING PR can be approved (status ${existing.status})`);
    const pr = await this.repo.updatePrStatus(ctx, id, rowVersion, 'APPROVED');
    if (!pr) throw Errors.conflict('Row version mismatch');
    return pr;
  }

  // ---- Purchase Order ------------------------------------------------------

  /** Create a DRAFT PO. Gate: the vendor must exist in the company and be approved (else 409). */
  async createPo(ctx: RequestContext, dto: CreatePoDto): Promise<PurchaseOrder> {
    if (!ctx.buId) throw Errors.badRequest('A branch (x-bu-id) is required to allocate a PO number');
    const approved = await this.repo.vendorIsApproved(ctx, dto.vendorId);
    if (approved === null) throw Errors.notFound(`Vendor ${dto.vendorId} not found`);
    if (!approved) throw Errors.conflict(`Vendor ${dto.vendorId} is not approved — a PO can only be raised on an approved vendor`);
    const header: PoHeaderInput = {
      vendorId: dto.vendorId, projectId: dto.projectId, prId: dto.prId, expectedDate: dto.expectedDate,
    };
    const lines: PoLineInput[] = dto.lines.map((l) => ({
      itemId: l.itemId, qty: l.qty, unitRate: l.unitRate, needByDate: l.needByDate,
    }));
    return this.repo.createPo(ctx, header, lines);
  }

  async getPo(ctx: RequestContext, id: number): Promise<PurchaseOrder> {
    const po = await this.repo.findPo(ctx, id);
    if (!po) throw Errors.notFound(`Purchase order ${id} not found`);
    return po;
  }
  listPo(ctx: RequestContext, query: PoListQueryDto) { return this.repo.listPo(ctx, query); }

  /**
   * Approve a PO (DRAFT/PENDING -> APPROVED). Route is gated by
   * PURCHASE_ORDER.APPROVE (CEO / PURCHASE by value). Emits 'po.approved' to the
   * outbox in the same transaction for downstream commitment / profitability.
   * SoD: a buyer cannot approve their own PO. Returns the committed cost.
   */
  async approvePo(ctx: RequestContext, id: number, rowVersion: number): Promise<PoApprovalResult> {
    const existing = await this.getPo(ctx, id);
    if (existing.createdBy === ctx.userId) {
      throw Errors.forbidden('Segregation of Duties: you cannot approve a purchase order you created');
    }
    if (existing.status !== 'DRAFT' && existing.status !== 'PENDING') {
      throw Errors.conflict(`Only a DRAFT/PENDING PO can be approved (status ${existing.status})`);
    }
    const po = await this.repo.updatePoStatus(ctx, id, rowVersion, 'APPROVED', {
      eventType: PO_APPROVED_EVENT, aggregateType: PO_AGGREGATE, aggregateId: id,
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: {
        poNo: existing.poNo, vendorId: existing.vendorId, projectId: existing.projectId,
        committedCost: existing.totalAmount, currencyId: existing.currencyId,
      },
    });
    if (!po) throw Errors.conflict('Purchase order was modified by someone else (row version mismatch)');
    return { purchaseOrder: po, committedCost: po.totalAmount };
  }

  // ---- Goods Receipt -------------------------------------------------------

  async getGrn(ctx: RequestContext, id: number): Promise<GoodsReceipt> {
    const grn = await this.repo.findGrn(ctx, id);
    if (!grn) throw Errors.notFound(`Goods receipt ${id} not found`);
    return grn;
  }
  listGrn(ctx: RequestContext, query: GrnListQueryDto) { return this.repo.listGrn(ctx, query); }

  /** Receive goods against an APPROVED/PARTIAL PO. Numbered 'GRN'; ties to the PO's vendor. */
  async receiveGrn(ctx: RequestContext, dto: ReceiveGrnDto): Promise<GoodsReceipt> {
    if (!ctx.buId) throw Errors.badRequest('A branch (x-bu-id) is required to allocate a GRN number');
    const po = await this.getPo(ctx, dto.poId);
    const receivable: PurchaseOrder['status'][] = ['APPROVED', 'PARTIAL'];
    if (!receivable.includes(po.status)) {
      throw Errors.conflict(`Goods can only be received against an APPROVED PO (status ${po.status})`);
    }
    const warehouseId = dto.warehouseId ?? (await this.repo.defaultWarehouseForBu(ctx));
    if (!warehouseId) throw Errors.badRequest('A warehouse is required to receive goods (no warehouse for this branch)');
    const lines: GrnLineInput[] = dto.lines.map((l) => ({
      poLineId: l.poLineId, itemId: l.itemId, receivedQty: l.receivedQty,
      acceptedQty: l.acceptedQty, rejectedQty: l.rejectedQty,
    }));
    return this.repo.receiveGrn(ctx, po.poId, po.vendorId, warehouseId, lines);
  }
}
