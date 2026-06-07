import { InvoiceStatus, RetentionStatus, RevenueMethod } from './billing.constants';

/** An invoice line (camelCase projection of fin.invoice_line). */
export interface InvoiceLine {
  invoiceLineId?: number;
  itemId: number | null;
  description: string;
  qty: number;
  unitRate: number;
  taxableAmount: number;
  taxCodeId: number | null;
  taxAmount: number;
}

/**
 * A persisted customer invoice with its lines (projection of fin.invoice +
 * fin.invoice_line). irn / ack_no are owned by the Tax module (e-invoice
 * stamping) and are deliberately NOT projected here.
 */
export interface Invoice {
  invoiceId: number;
  invoiceNo: string;
  companyId: number;
  buId: number | null;
  projectId: number | null;
  customerId: number;
  milestoneId: number | null;
  invoiceDate: string;
  currencyId: number;
  taxableAmount: number;
  taxAmount: number;
  totalAmount: number;
  status: InvoiceStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  lines: InvoiceLine[];
}

/** A customer receipt header (projection of fin.payment_receipt). */
export interface Receipt {
  receiptId: number;
  receiptNo: string;
  companyId: number;
  customerId: number;
  receiptDate: string;
  amount: number;
  mode: string | null;
  reference: string | null;
  allocations: Allocation[];
}

/** A receipt-to-invoice allocation (projection of fin.payment_allocation). */
export interface Allocation {
  allocationId?: number;
  receiptId: number;
  invoiceId: number;
  allocatedAmount: number;
}

/** A customer advance (projection of fin.advance). */
export interface Advance {
  advanceId: number;
  projectId: number;
  customerId: number;
  advanceDate: string;
  amount: number;
  adjustedAmount: number;
}

/** A retention-money record (projection of fin.retention). */
export interface Retention {
  retentionId: number;
  projectId: number;
  invoiceId: number | null;
  retainedAmount: number;
  releaseDueDate: string | null;
  releasedAmount: number;
  status: RetentionStatus;
}

/** A revenue-recognition entry (projection of fin.revenue_recognition). */
export interface RevenueEntry {
  revId: number;
  projectId: number;
  milestoneId: number | null;
  recognitionDate: string;
  method: RevenueMethod;
  amount: number;
}

export interface ListResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** List view of invoices omits the (potentially large) line array. */
export type InvoiceListResult = ListResult<Omit<Invoice, 'lines'>>;
