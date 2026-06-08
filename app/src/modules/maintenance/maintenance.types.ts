import { AssetType, AssetStatus, WoType, WoStatus } from './maintenance.constants';

/**
 * A persisted maintenance asset (camelCase projection of maint.asset, created in
 * migration 033). One row per maintainable machine / tool / vehicle / instrument.
 */
export interface Asset {
  assetId: number;
  companyId: number;
  assetCode: string;
  assetName: string;
  assetType: AssetType | null;
  location: string | null;
  status: AssetStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

/**
 * A persisted maintenance work order (camelCase projection of maint.work_order).
 * A PREVENTIVE / BREAKDOWN / CALIBRATION job raised against one asset.
 */
export interface WorkOrder {
  mwoId: number;
  companyId: number;
  buId: number | null;
  mwoNo: string;
  assetId: number;
  woType: WoType;
  scheduledDate: string | null;
  completedDate: string | null;
  status: WoStatus;
  notes: string | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface AssetListResult {
  rows: Asset[];
  total: number;
  page: number;
  pageSize: number;
}

export interface WorkOrderListResult {
  rows: WorkOrder[];
  total: number;
  page: number;
  pageSize: number;
}
