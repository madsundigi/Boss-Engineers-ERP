import { DispatchStatus } from './dispatch.constants';

/** A shipment serial line (camelCase projection of log.dispatch_line). */
export interface DispatchSerial {
  dispatchLineId?: number;
  itemId: number;
  serialId: number | null;
  qty: number;
}

/** A package on the packing list (camelCase projection of log.packing_list). */
export interface PackingLine {
  packingId?: number;
  packageNo: string;
  grossWeight: number | null;
  dimensions: string | null;
}

/** A persisted dispatch row (camelCase projection of log.dispatch). */
export interface Dispatch {
  dispatchId: number;
  dispatchNo: string;
  companyId: number;
  buId: number | null;
  projectId: number;
  customerId: number;
  fatId: number | null;
  dispatchDate: string;
  shipToAddressId: number | null;
  transporter: string | null;
  lrNo: string | null;
  ewayBillNo: string | null;
  status: DispatchStatus;
  qualityClearedBy: number | null;
  qualityClearedAt: string | null;
  commercialClearedBy: number | null;
  commercialClearedAt: string | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  serials: DispatchSerial[];
  packingLines: PackingLine[];
}

export interface DispatchListResult {
  rows: Omit<Dispatch, 'serials' | 'packingLines'>[];
  total: number;
  page: number;
  pageSize: number;
}
