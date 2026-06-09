import { WoOpStatus, WoStatus } from './production.constants';

/** A routing operation on a work order (camelCase projection of mfg.work_order_operation). */
export interface WorkOrderOperation {
  woOpId?: number;
  opSeq: number;
  workCenterId: number;
  stdTimeMin: number;
  actualTimeMin: number;
  status: WoOpStatus;
}

/** A material requirement line (camelCase projection of mfg.work_order_material). */
export interface WorkOrderMaterial {
  woMatId?: number;
  itemId: number;
  requiredQty: number;
  issuedQty: number;
}

/** A production confirmation against an operation (mfg.production_confirmation). */
export interface ProductionConfirmation {
  confId: number;
  woOpId: number;
  qtyDone: number;
  qtyScrap: number;
  qtyRework: number;
  labourHours: number;
  confDate: string;
  confirmedBy: number | null;
}

/** An as-built serial recorded at completion (mfg.as_built + scm.serial_number). */
export interface AsBuiltSerial {
  asBuiltId?: number;
  serialId: number;
  serialNo: string;
  parentSerialId: number | null;
  builtAt?: string;
}

/** A persisted work-order row (camelCase projection of mfg.work_order). */
export interface WorkOrder {
  woId: number;
  woNo: string;
  companyId: number;
  buId: number | null;
  projectId: number;
  wbsId: number | null;
  itemId: number;
  bomId: number | null;
  routingId: number | null;
  qty: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  status: WoStatus;
  delayReason: string | null;
  percentComplete: number | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  operations: WorkOrderOperation[];
  materials: WorkOrderMaterial[];
  confirmations: ProductionConfirmation[];
  asBuilt: AsBuiltSerial[];
}

export interface WorkOrderListResult {
  rows: Omit<WorkOrder, 'operations' | 'materials' | 'confirmations' | 'asBuilt'>[];
  total: number;
  page: number;
  pageSize: number;
}
