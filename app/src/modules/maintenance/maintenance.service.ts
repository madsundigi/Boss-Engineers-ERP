import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { MaintenanceRepository } from './maintenance.repository';
import { Asset, WorkOrder, AssetListResult, WorkOrderListResult } from './maintenance.types';
import {
  CreateAssetDto, UpdateAssetDto, SetAssetStatusDto, AssetListQueryDto,
  CreateWoDto, UpdateWoDto, WoListQueryDto,
} from './maintenance.dto';
import { canTransitionWo, WoStatus, MAINTENANCE_COMPLETED_EVENT } from './maintenance.constants';

const WO_TERMINAL: WoStatus[] = ['DONE', 'CANCELLED'];

/**
 * MaintenanceService — Plant Maintenance business logic (asset register + maintenance
 * work orders). Stateless; depends only on the injected repository so it is unit-
 * testable without a database. Enforces the OPEN -> IN_PROGRESS -> DONE (+ CANCELLED)
 * work-order lifecycle, drives the asset ACTIVE <-> UNDER_MAINTENANCE status from it,
 * and emits 'maintenance.completed' when a work order is completed.
 */
export class MaintenanceService {
  constructor(private readonly repo: MaintenanceRepository) {}

  // -------------------------------------------------------------------
  // Asset register
  // -------------------------------------------------------------------

  createAsset(ctx: RequestContext, dto: CreateAssetDto): Promise<Asset> {
    return this.repo.createAsset(ctx, dto);
  }

  async getAsset(ctx: RequestContext, id: number): Promise<Asset> {
    const row = await this.repo.findAssetById(ctx, id);
    if (!row) throw Errors.notFound(`Asset ${id} not found`);
    return row;
  }

  listAssets(ctx: RequestContext, query: AssetListQueryDto): Promise<AssetListResult> {
    return this.repo.listAssets(ctx, query);
  }

  async updateAsset(ctx: RequestContext, id: number, dto: UpdateAssetDto): Promise<Asset> {
    const { rowVersion, ...fields } = dto;
    const existing = await this.getAsset(ctx, id);
    if (existing.status === 'RETIRED') {
      throw Errors.conflict('Cannot edit a RETIRED asset');
    }
    const updated = await this.repo.updateAsset(ctx, id, rowVersion, fields);
    if (!updated) throw Errors.conflict('Asset was modified by someone else (row version mismatch)');
    return updated;
  }

  async setAssetStatus(ctx: RequestContext, id: number, dto: SetAssetStatusDto): Promise<Asset> {
    await this.getAsset(ctx, id); // 404 if missing
    const updated = await this.repo.setAssetStatus(ctx, id, dto.rowVersion, dto.status);
    if (!updated) throw Errors.conflict('Asset was modified by someone else (row version mismatch)');
    return updated;
  }

  async deleteAsset(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    const existing = await this.getAsset(ctx, id);
    if (existing.status === 'UNDER_MAINTENANCE') {
      throw Errors.conflict('Cannot delete an asset that is UNDER_MAINTENANCE');
    }
    const ok = await this.repo.softDeleteAsset(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Asset was modified by someone else (row version mismatch)');
  }

  // -------------------------------------------------------------------
  // Maintenance work order
  // -------------------------------------------------------------------

  /** Raise a maintenance work order (OPEN) against an asset. Requires a branch
   *  (ctx.buId) to allocate the branch-scoped MWO number; the asset must exist. */
  async createWo(ctx: RequestContext, dto: CreateWoDto): Promise<WorkOrder> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a maintenance work-order number');
    }
    await this.getAsset(ctx, dto.assetId); // 404 if the asset is missing / wrong tenant
    return this.repo.createWo(ctx, dto);
  }

  async getWo(ctx: RequestContext, id: number): Promise<WorkOrder> {
    const row = await this.repo.findWoById(ctx, id);
    if (!row) throw Errors.notFound(`Maintenance work order ${id} not found`);
    return row;
  }

  listWo(ctx: RequestContext, query: WoListQueryDto): Promise<WorkOrderListResult> {
    return this.repo.listWo(ctx, query);
  }

  async updateWo(ctx: RequestContext, id: number, dto: UpdateWoDto): Promise<WorkOrder> {
    const { rowVersion, ...fields } = dto;
    const existing = await this.getWo(ctx, id);
    if (WO_TERMINAL.includes(existing.status)) {
      throw Errors.conflict(`Cannot edit a ${existing.status} work order`);
    }
    const updated = await this.repo.updateWo(ctx, id, rowVersion, fields);
    if (!updated) throw Errors.conflict('Work order was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Start an OPEN work order (OPEN -> IN_PROGRESS) and put its asset
   *  UNDER_MAINTENANCE in the same transaction. */
  async startWo(ctx: RequestContext, id: number, rowVersion: number): Promise<WorkOrder> {
    const existing = await this.getWo(ctx, id);
    if (!canTransitionWo(existing.status, 'IN_PROGRESS')) {
      throw Errors.conflict(`Cannot start a ${existing.status} work order`);
    }
    const updated = await this.repo.setWoStatus(ctx, id, rowVersion, 'IN_PROGRESS', {
      assetId: existing.assetId, assetStatus: 'UNDER_MAINTENANCE',
    });
    if (!updated) throw Errors.conflict('Work order was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Complete an IN_PROGRESS work order (IN_PROGRESS -> DONE): stamp completed_date,
   * return the asset to ACTIVE, and emit 'maintenance.completed' — all atomically.
   */
  async completeWo(ctx: RequestContext, id: number, rowVersion: number): Promise<WorkOrder> {
    const existing = await this.getWo(ctx, id);
    if (!canTransitionWo(existing.status, 'DONE')) {
      throw Errors.conflict(`Cannot complete a ${existing.status} work order`);
    }
    const updated = await this.repo.setWoStatus(ctx, id, rowVersion, 'DONE', {
      assetId: existing.assetId, assetStatus: 'ACTIVE', setCompletedDate: true,
      event: {
        eventType: MAINTENANCE_COMPLETED_EVENT, aggregateType: 'MAINTENANCE_WO', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: { mwoNo: existing.mwoNo, assetId: existing.assetId, woType: existing.woType },
      },
    });
    if (!updated) throw Errors.conflict('Work order was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Cancel an OPEN / IN_PROGRESS work order. If the asset was UNDER_MAINTENANCE for
   *  this job, return it to ACTIVE in the same transaction. */
  async cancelWo(ctx: RequestContext, id: number, rowVersion: number): Promise<WorkOrder> {
    const existing = await this.getWo(ctx, id);
    if (!canTransitionWo(existing.status, 'CANCELLED')) {
      throw Errors.conflict(`Cannot cancel a ${existing.status} work order`);
    }
    const restore = existing.status === 'IN_PROGRESS'
      ? { assetId: existing.assetId, assetStatus: 'ACTIVE' as const }
      : {};
    const updated = await this.repo.setWoStatus(ctx, id, rowVersion, 'CANCELLED', restore);
    if (!updated) throw Errors.conflict('Work order was modified by someone else (row version mismatch)');
    return updated;
  }

  async deleteWo(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    const existing = await this.getWo(ctx, id);
    if (existing.status === 'IN_PROGRESS') {
      throw Errors.conflict('Cannot delete an IN_PROGRESS work order');
    }
    const ok = await this.repo.softDeleteWo(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Work order was modified by someone else (row version mismatch)');
  }

  /** MAINTENANCE.EXPORT — CSV of the (filtered) work-order list. */
  async exportWoCsv(ctx: RequestContext, query: WoListQueryDto): Promise<string> {
    const { rows } = await this.repo.listWo(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['MWO No', 'Asset', 'Type', 'Status', 'Scheduled', 'Completed', 'Notes', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.mwoNo, r.assetId, r.woType, r.status, r.scheduledDate, r.completedDate, r.notes, r.createdAt,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
