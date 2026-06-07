import { PrStatus, PoStatus, GrnStatus } from './procurement.constants';

// ---- Purchase Requisition --------------------------------------------------

export interface PrLine {
  prLineId?: number;
  itemId: number;
  qty: number;
  uomId: number | null;
  requiredDate: string | null;
}

export interface PurchaseRequisition {
  prId: number;
  prNo: string;
  companyId: number;
  buId: number | null;
  projectId: number | null;
  wbsId: number | null;
  requiredDate: string | null;
  status: PrStatus;
  createdBy: number | null;
  createdAt: string;
  rowVersion: number;
  lines: PrLine[];
}

// ---- Purchase Order --------------------------------------------------------

export interface PoLine {
  poLineId?: number;
  itemId: number;
  qty: number;
  receivedQty: number;
  unitRate: number;
  lineAmount: number;
  needByDate: string | null;
}

export interface PurchaseOrder {
  poId: number;
  poNo: string;
  companyId: number;
  buId: number | null;
  vendorId: number;
  projectId: number | null;
  poDate: string;
  currencyId: number;
  totalAmount: number;
  expectedDate: string | null;
  status: PoStatus;
  createdBy: number | null;
  createdAt: string;
  rowVersion: number;
  lines: PoLine[];
}

// ---- Goods Receipt Note ----------------------------------------------------

export interface GrnLine {
  grnLineId?: number;
  poLineId: number | null;
  itemId: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  warehouseId: number;
}

export interface GoodsReceipt {
  grnId: number;
  grnNo: string;
  companyId: number;
  buId: number | null;
  poId: number | null;
  vendorId: number;
  grnDate: string;
  status: GrnStatus;
  createdBy: number | null;
  createdAt: string;
  rowVersion: number;
  lines: GrnLine[];
}
