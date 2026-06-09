import { VendorStatus } from './vendors.constants';

/**
 * A persisted vendor (camelCase projection of mdm.vendor, defined in
 * db/01_security_master.sql). All audit/concurrency columns are surfaced so the API
 * can drive optimistic concurrency (rowVersion) and show provenance.
 */
export interface Vendor {
  vendorId: number;
  companyId: number;
  vendorCode: string;
  vendorName: string;
  gstin: string | null;
  pan: string | null;
  msmeFlag: boolean;
  isApproved: boolean;
  paymentTermId: number | null;
  rating: number | null;
  status: VendorStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface VendorListResult {
  rows: Vendor[];
  total: number;
  page: number;
  pageSize: number;
}
