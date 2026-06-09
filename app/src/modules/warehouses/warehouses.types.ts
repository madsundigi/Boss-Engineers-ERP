/**
 * A persisted warehouse (camelCase projection of mdm.warehouse, defined in
 * db/01_security_master.sql). The table is minimal — no audit, no row_version, no
 * is_deleted. companyId is NOT a column; it is resolved via the parent business unit
 * and surfaced here for the caller's convenience.
 */
export interface Warehouse {
  warehouseId: number;
  buId: number;
  whCode: string;
  whName: string;
  isActive: boolean;
  companyId: number; // resolved via mdm.business_unit (not stored on the row)
}

export interface WarehouseListResult {
  rows: Warehouse[];
  total: number;
  page: number;
  pageSize: number;
}
