/**
 * A per-location on-hand balance for a spare (camelCase projection of
 * svc.spare_stock, created in migration 032).
 */
export interface SpareStock {
  stockId: number;
  spareId: number;
  location: string;
  qtyOnHand: number;
}

/**
 * A persisted spare part (camelCase projection of svc.spare_part, created in
 * migration 032). `stock` is the list of per-location balances; it is populated on
 * getById (and is undefined on list rows, which are header-only for speed).
 */
export interface SparePart {
  spareId: number;
  companyId: number;
  partCode: string;
  partName: string;
  uom: string | null;
  itemId: number | null;
  unitPrice: number;
  reorderLevel: number;
  isActive: boolean;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  stock?: SpareStock[];
}

export interface SparePartListResult {
  rows: SparePart[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One row of the low-stock read: a spare whose total on-hand across all locations
 * has fallen to or below its reorder level (a replenishment candidate).
 */
export interface LowStockRow {
  spareId: number;
  partCode: string;
  partName: string;
  uom: string | null;
  reorderLevel: number;
  totalOnHand: number;
}
