import { VendorInvoiceStatus } from './payables.constants';

/** A vendor-invoice line (camelCase projection of fin.vendor_invoice_line). */
export interface VendorInvoiceLine {
  vinvLineId?: number;
  itemId: number | null;
  qty: number | null;
  unitRate: number | null;
  amount: number;
}

/** A persisted vendor-invoice header with its lines (projection of fin.vendor_invoice). */
export interface VendorInvoice {
  vendorInvoiceId: number;
  companyId: number;
  buId: number | null;
  vinvNo: string;
  vendorId: number;
  poId: number | null;
  grnId: number | null;
  invoiceDate: string;
  totalAmount: number;
  status: VendorInvoiceStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  lines: VendorInvoiceLine[];
}

/** A persisted vendor payment (projection of fin.vendor_payment). */
export interface VendorPayment {
  vpayId: number;
  companyId: number;
  buId: number | null;
  vpayNo: string;
  vendorId: number;
  vendorInvoiceId: number | null;
  payDate: string;
  amount: number;
}

export interface ListResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** A vendor-invoice list page (header rows only — no nested lines). */
export type VendorInvoiceListResult = ListResult<Omit<VendorInvoice, 'lines'>>;
