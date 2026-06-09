/**
 * A persisted work centre (camelCase projection of mdm.work_center, created in
 * db/01_security_master.sql). The table carries no company_id / row_version /
 * is_deleted / audit columns; companyId is surfaced from the parent business unit
 * (it is NOT a column on the table itself).
 */
export interface WorkCenter {
  wcId: number;
  buId: number;
  companyId: number; // derived from the parent mdm.business_unit (not stored on the row)
  wcCode: string;
  wcName: string;
  capacityPerDay: number;
  costRate: number;
  isActive: boolean;
}

export interface WorkCenterListResult {
  rows: WorkCenter[];
  total: number;
  page: number;
  pageSize: number;
}
