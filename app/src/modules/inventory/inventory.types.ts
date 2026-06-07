import { AdjustmentStatus, AdjustmentType, CriticalReason, CriticalStatus } from './inventory.constants';

/** A stock balance row (camelCase projection of scm.item_stock joined to mdm.item). */
export interface StockRow {
  stockId: number;
  companyId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  warehouseId: number;
  warehouseCode: string | null;
  binId: number | null;
  batchId: number | null;
  projectId: number | null;
  qtyOnHand: number;
  qtyReserved: number;
  qtyAvailable: number;
  avgCost: number;
  updatedAt: string;
}

export interface StockListResult {
  rows: StockRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** A stock-adjustment / receipt / write-off document (scm.stock_adjustment). */
export interface StockAdjustment {
  adjId: number;
  companyId: number;
  itemId: number;
  warehouseId: number;
  projectId: number | null;
  adjType: AdjustmentType;
  qty: number;
  unitCost: number;
  reason: string | null;
  status: AdjustmentStatus;
  approvedBy: number | null;
  approvedAt: string | null;
  createdAt: string;
  createdBy: number | null;
  rowVersion: number;
}

/** A material reservation header against a project (scm.material_reservation). */
export interface Reservation {
  reservationId: number;
  projectId: number;
  wbsId: number | null;
  itemId: number;
  qty: number;
  warehouseId: number;
  status: string;
  reservedAt: string;
}

/** A material issue header + its issued lines (scm.material_issue/_line). */
export interface MaterialIssue {
  issueId: number;
  companyId: number;
  issueNo: string;
  projectId: number;
  woId: number | null;
  itemId: number;
  qty: number;
  warehouseId: number;
  unitCost: number;
  issueDate: string;
  createdAt: string;
}

/** A critical-item register row with a derived early-warning flag. */
export interface CriticalItemRow {
  critId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  projectId: number;
  projectNo: string | null;
  reason: CriticalReason;
  status: CriticalStatus;
  orderByDate: string | null;
  leadTimeDays: number;
  qtyAvailable: number;
  /** True when the item must be ordered now (order_by_date within lead time / past due) and not yet ordered. */
  earlyWarning: boolean;
}
