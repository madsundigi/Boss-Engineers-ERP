import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { SubcontractRepository, SubcontractHeaderInput, HeaderPatch } from './subcontract.repository';
import {
  SubcontractOrder, SubcontractListResult, SubcontractIssue, SubcontractReceipt,
} from './subcontract.types';
import {
  CreateSubcontractDto, UpdateSubcontractDto, IssueDto, ReceiveDto, CancelDto, ListQueryDto,
} from './subcontract.dto';
import {
  canTransition, SUBCONTRACT_AGGREGATE, SUBCONTRACT_RECEIVED_EVENT,
} from './subcontract.constants';

type LineDto = { itemId: number; qty: number };

/**
 * SubcontractService — business logic for the Subcontracting / Job-Work module.
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. Models the job-work flow: a vendor order is opened (OPEN),
 * raw material is ISSUED to the vendor, the processed goods come back (RECEIVED),
 * then the order is CLOSED. RECEIVED emits 'subcontract.received' atomically.
 */
export class SubcontractService {
  constructor(private readonly repo: SubcontractRepository) {}

  private mapLines<T extends SubcontractIssue | SubcontractReceipt>(dto?: LineDto[]): T[] {
    return (dto ?? []).map((l) => ({ itemId: l.itemId, qty: l.qty } as T));
  }

  async create(ctx: RequestContext, dto: CreateSubcontractDto): Promise<SubcontractOrder> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a subcontract number');
    }
    const header: SubcontractHeaderInput = {
      vendorId: dto.vendorId, projectId: dto.projectId, scoDate: dto.scoDate,
    };
    // The order is created with no children; planned items become issue rows only
    // on /issue (when the material physically moves to the vendor).
    return this.repo.create(ctx, header);
  }

  async getById(ctx: RequestContext, id: number): Promise<SubcontractOrder> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Subcontract order ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<SubcontractListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateSubcontractDto): Promise<SubcontractOrder> {
    const { rowVersion, items, ...rest } = dto;
    const fields = rest as HeaderPatch;
    if (Object.keys(fields).length === 0 && !items) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status !== 'OPEN') {
      throw Errors.conflict(`Only an OPEN subcontract order can be edited (current: ${existing.status})`);
    }
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) {
      throw Errors.conflict('Subcontract order was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Issue material to the vendor (OPEN -> ISSUED). Inserts subcontract_issue rows
   * for the supplied (or, if omitted, must be supplied — there is no plan store)
   * lines. At least one line is required so something physically moves.
   */
  async issueMaterial(ctx: RequestContext, id: number, dto: IssueDto): Promise<SubcontractOrder> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'ISSUED')) {
      throw Errors.conflict(`Only an OPEN subcontract order can be issued (current: ${existing.status})`);
    }
    const issues = this.mapLines<SubcontractIssue>(dto.items);
    if (issues.length === 0) {
      throw Errors.badRequest('At least one item line is required to issue material');
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'ISSUED', { issues });
    if (!updated) throw Errors.conflict('Subcontract order was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Receive processed goods back from the vendor (ISSUED -> RECEIVED). Inserts
   * subcontract_receipt rows and emits 'subcontract.received' atomically so
   * downstream (inventory take-in / job-work GL) reacts. At least one line.
   */
  async receiveGoods(ctx: RequestContext, id: number, dto: ReceiveDto): Promise<SubcontractOrder> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'RECEIVED')) {
      throw Errors.conflict(`Only an ISSUED subcontract order can be received (current: ${existing.status})`);
    }
    const receipts = this.mapLines<SubcontractReceipt>(dto.items);
    if (receipts.length === 0) {
      throw Errors.badRequest('At least one item line is required to receive goods');
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'RECEIVED', {
      receipts,
      event: {
        eventType: SUBCONTRACT_RECEIVED_EVENT, aggregateType: SUBCONTRACT_AGGREGATE, aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: {
          scNo: existing.scoNo,
          vendorId: existing.vendorId,
          projectId: existing.projectId,
        },
      },
    });
    if (!updated) throw Errors.conflict('Subcontract order was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Close a fully-received order (RECEIVED -> CLOSED). */
  async close(ctx: RequestContext, id: number, rowVersion: number): Promise<SubcontractOrder> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CLOSED')) {
      throw Errors.conflict(`Only a RECEIVED subcontract order can be closed (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'CLOSED');
    if (!updated) throw Errors.conflict('Subcontract order was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Cancel an OPEN or ISSUED order with a reason. */
  async cancel(ctx: RequestContext, id: number, dto: CancelDto): Promise<SubcontractOrder> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CANCELLED')) {
      throw Errors.conflict(`Cannot cancel a subcontract order in status ${existing.status}`);
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'CANCELLED');
    if (!updated) throw Errors.conflict('Subcontract order was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'OPEN') {
      throw Errors.conflict(`Only an OPEN subcontract order can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** SUBCONTRACT.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['SC No', 'Vendor', 'Project', 'SC Date', 'Status', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.scoNo, r.vendorId, r.projectId, r.scoDate, r.status, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
