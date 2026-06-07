/** A GST rate-master row (camelCase projection of mdm.tax_code). GLOBAL master. */
export interface TaxCode {
  taxCodeId: number;
  code: string;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  isActive: boolean;
}

/** An append-only GST ledger row (camelCase projection of fin.tax_transaction). */
export interface TaxTransaction {
  taxTxnId: number;
  companyId: number;
  docType: string;
  docId: number;
  txnDate: string;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface TaxTransactionListResult {
  rows: TaxTransaction[];
  total: number;
  page: number;
  pageSize: number;
}

/** The GST split written to the ledger when an invoice is e-invoiced. */
export interface GstSplit {
  cgst: number;
  sgst: number;
  igst: number;
}

/** Result of generateEInvoice — the IRN, ack number and the GST split applied. */
export interface EInvoiceResult extends GstSplit {
  irn: string;
  ackNo: string;
}

/** Result of generateEwayBill — the (mock) 12-digit e-way bill number. */
export interface EwayBillResult {
  ewayBillNo: string;
}

/**
 * GSTR-style liability summary over fin.tax_transaction for a period: the sum of
 * taxable value and each GST head, plus the row count.
 */
export interface GstSummary {
  fromDate: string;
  toDate: string;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  count: number;
}

/**
 * The subset of fin.invoice this module reads/stamps. fin.invoice is OWNED by the
 * AR Billing module; we only SELECT these columns and UPDATE irn / ack_no /
 * eway_bill_no (company_id unchanged, so Billing's RLS company policy is satisfied).
 */
export interface InvoiceForTax {
  invoiceId: number;
  companyId: number;
  invoiceNo: string;
  invoiceDate: string;
  taxableAmount: number;
  taxAmount: number;
  totalAmount: number;
  status: string;
  irn: string | null;
  ackNo: string | null;
  ewayBillNo: string | null;
}
