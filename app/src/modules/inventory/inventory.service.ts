import { Errors } from '../../common/http-error';
import { RequestContext, hasPermission } from '../../common/request-context';
import { InventoryRepository } from './inventory.repository';
import {
  StockRow, StockListResult, StockAdjustment, Reservation, MaterialIssue, CriticalItemRow,
} from './inventory.types';
import {
  StockListQueryDto, CreateAdjustmentDto, CreateReservationDto, CreateIssueDto, CriticalListQueryDto,
} from './inventory.dto';
import { INVENTORY_PERMS } from './inventory.constants';

/**
 * InventoryService — business logic for the Inventory & Critical Items module.
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. The availability guards (no over-reserve / over-issue) and
 * the write-off approval rule live here.
 */
export class InventoryService {
  constructor(private readonly repo: InventoryRepository) {}

  // ---- stock list -------------------------------------------------------

  async listStock(ctx: RequestContext, query: StockListQueryDto): Promise<StockListResult> {
    return this.repo.listStock(ctx, query);
  }

  // ---- adjustments ------------------------------------------------------

  async createAdjustment(ctx: RequestContext, dto: CreateAdjustmentDto): Promise<StockAdjustment> {
    return this.repo.createAdjustment(ctx, dto);
  }

  async listAdjustments(ctx: RequestContext): Promise<StockAdjustment[]> {
    return this.repo.listAdjustments(ctx);
  }

  async getAdjustment(ctx: RequestContext, id: number): Promise<StockAdjustment> {
    const row = await this.repo.findAdjustment(ctx, id);
    if (!row) throw Errors.notFound(`Stock adjustment ${id} not found`);
    return row;
  }

  /**
   * Approve a stock adjustment and post it to stock. A WRITE_OFF (stock out) is a
   * value-destroying event and MUST be signed off by an INVENTORY.APPROVE holder
   * (FINANCE/CEO) — separation of duty from the stores user who raised it.
   */
  async approveAdjustment(ctx: RequestContext, id: number, rowVersion: number): Promise<StockAdjustment> {
    const existing = await this.getAdjustment(ctx, id); // 404 if missing
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT adjustment can be approved (current: ${existing.status})`);
    }
    if (existing.adjType === 'WRITE_OFF' && !hasPermission(ctx, INVENTORY_PERMS.APPROVE)) {
      throw Errors.forbidden(`Missing permission: ${INVENTORY_PERMS.APPROVE} (required to post a write-off)`);
    }
    const posted = await this.repo.approveAndPostAdjustment(ctx, id, rowVersion);
    if (!posted) {
      throw Errors.conflict('Adjustment was modified by someone else (row version mismatch)', {
        expected: rowVersion,
        current: existing.rowVersion,
      });
    }
    return posted;
  }

  async rejectAdjustment(ctx: RequestContext, id: number, rowVersion: number): Promise<StockAdjustment> {
    const existing = await this.getAdjustment(ctx, id);
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT adjustment can be rejected (current: ${existing.status})`);
    }
    const rejected = await this.repo.rejectAdjustment(ctx, id, rowVersion);
    if (!rejected) {
      throw Errors.conflict('Adjustment was modified by someone else (row version mismatch)');
    }
    return rejected;
  }

  // ---- reserve ----------------------------------------------------------

  /** Reserve stock against a project. 409 if available stock is insufficient. */
  async reserve(ctx: RequestContext, dto: CreateReservationDto): Promise<Reservation> {
    const { result, reservation } = await this.repo.reserve(ctx, dto);
    if (!result.ok || !reservation) {
      throw Errors.conflict(
        `Insufficient available stock to reserve ${dto.qty}; available ${result.available}`,
        { requested: dto.qty, available: result.available },
      );
    }
    return reservation;
  }

  // ---- issue ------------------------------------------------------------

  /**
   * Issue (consume) stock to a project / work order. The repository decrements
   * on-hand atomically only if enough is present; a shortfall returns 409 so an
   * issue can never drive stock negative (over-issue guard).
   */
  async issue(ctx: RequestContext, dto: CreateIssueDto): Promise<MaterialIssue> {
    const { result, issue } = await this.repo.issue(ctx, dto);
    if (!result.ok || !issue) {
      throw Errors.conflict(
        `Cannot issue ${dto.qty}; only ${result.available} on hand at warehouse`,
        { requested: dto.qty, onHand: result.available },
      );
    }
    return issue;
  }

  // ---- critical items ---------------------------------------------------

  async listCritical(ctx: RequestContext, query: CriticalListQueryDto): Promise<CriticalItemRow[]> {
    return this.repo.listCritical(ctx, query);
  }

  // ---- export -----------------------------------------------------------

  /** INVENTORY.EXPORT — CSV of the (filtered) stock list. */
  async exportStockCsv(ctx: RequestContext, query: StockListQueryDto): Promise<string> {
    const { rows } = await this.repo.listStock(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Item Code', 'Item Name', 'Warehouse', 'Project', 'On Hand', 'Reserved', 'Available', 'Avg Cost'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r: StockRow) =>
      [r.itemCode, r.itemName, r.warehouseCode, r.projectId, r.qtyOnHand, r.qtyReserved, r.qtyAvailable, r.avgCost]
        .map(esc).join(','),
    );
    return [head.join(','), ...lines].join('\n');
  }
}
