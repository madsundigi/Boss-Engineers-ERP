import { SubcontractStatus } from './subcontract.constants';

/** A material-issue line: an item and a qty sent to the vendor for processing. */
export interface SubcontractIssue {
  sciId?: number;
  itemId: number;
  qty: number;
  issuedAt?: string;
}

/** A receipt line: an item and a qty of processed goods received back. */
export interface SubcontractReceipt {
  scrId?: number;
  itemId: number;
  qty: number;
  receivedAt?: string;
}

/** A persisted subcontract order (camelCase projection of scm.subcontract_order). */
export interface SubcontractOrder {
  scoId: number;
  scoNo: string;
  companyId: number;
  buId: number | null;
  vendorId: number;
  projectId: number | null;
  scoDate: string;
  status: SubcontractStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  issues: SubcontractIssue[];
  receipts: SubcontractReceipt[];
}

/** A list row: the header only (no child issue / receipt collections). */
export type SubcontractOrderHeader = Omit<SubcontractOrder, 'issues' | 'receipts'>;

export interface SubcontractListResult {
  rows: SubcontractOrderHeader[];
  total: number;
  page: number;
  pageSize: number;
}
