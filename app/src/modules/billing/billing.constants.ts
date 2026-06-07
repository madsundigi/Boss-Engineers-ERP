/** Domain constants for the Accounts Receivable — Customer Billing / Invoicing module. */

/**
 * Customer-invoice lifecycle (fin.invoice.status, db/05 ck_invoice_status):
 *   DRAFT -> POSTED -> SENT
 *   POSTED/SENT/PARTIALLY_PAID -> PARTIALLY_PAID / PAID (driven by receipt allocations)
 *   any non-PAID -> CANCELLED
 * DRAFT is fully editable; POSTED freezes the financials (amounts immutable) and
 * emits the 'invoice.posted' event. PARTIALLY_PAID/PAID are set by the receipt-
 * allocation engine, not by an explicit transition. PAID and CANCELLED are terminal.
 */
export const INVOICE_STATUS = [
  'DRAFT', 'POSTED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];

/**
 * Allowed *explicit* lifecycle transitions (post / markSent / cancel). The
 * payment states PARTIALLY_PAID and PAID are reached via allocation side-effects
 * (see the receipt path), so they are not listed as explicit transition targets.
 * Deny anything not listed.
 */
export const STATUS_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  DRAFT: ['POSTED', 'CANCELLED'],
  POSTED: ['SENT', 'CANCELLED'],
  SENT: ['CANCELLED'],
  PARTIALLY_PAID: ['CANCELLED'],
  PAID: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** A receipt allocation may only be applied against an invoice in one of these. */
export const ALLOCATABLE_STATUSES: InvoiceStatus[] = ['POSTED', 'SENT', 'PARTIALLY_PAID'];

/** Retention-money lifecycle (fin.retention.status, db/05 ck_retention_status). */
export const RETENTION_STATUS = ['HELD', 'PARTIAL', 'RELEASED'] as const;
export type RetentionStatus = (typeof RETENTION_STATUS)[number];

/** Revenue-recognition method (fin.revenue_recognition.method, db/05 ck_rev_method). */
export const REVENUE_METHOD = ['MILESTONE', 'POC', 'COMPLETED'] as const;
export type RevenueMethod = (typeof REVENUE_METHOD)[number];

/**
 * RBAC permission codes for this module (mirror sec.permission catalog, db/08 —
 * the INVOICE module x {VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT} is already seeded
 * there; grants: FINANCE = VCEDAX (all six), CEO = VX, ADMIN/SALES/PLANNING/
 * SERVICE = V). create + receipts/advances/retention/revenue -> INVOICE.CREATE;
 * update/post/markSent/cancel/adjust/release -> INVOICE.EDIT; every read ->
 * INVOICE.VIEW; soft-delete -> INVOICE.DELETE; CSV export -> INVOICE.EXPORT.
 */
export const INVOICE_PERMS = {
  VIEW: 'INVOICE.VIEW',
  CREATE: 'INVOICE.CREATE',
  EDIT: 'INVOICE.EDIT',
  DELETE: 'INVOICE.DELETE',
  APPROVE: 'INVOICE.APPROVE',
  EXPORT: 'INVOICE.EXPORT',
} as const;

/** Document-numbering types registered in mdm.numbering_rule (migration 020). */
export const INVOICE_DOC_TYPE = 'INVOICE'; // prefix 'INV'
export const RECEIPT_DOC_TYPE = 'RECEIPT'; // prefix 'RCT'

/** source_doc_type strings stamped on downstream documents / outbox payloads. */
export const DOC_TYPE_INVOICE = 'INVOICE';
export const DOC_TYPE_RECEIPT = 'RECEIPT';

/**
 * Domain event emitted when a customer invoice is POSTED (atomically with the
 * status change via the transactional outbox). Payload:
 *   { invoiceNo, customerId, projectId, totalAmount, taxableAmount }.
 * Downstream consumers (GL / profitability / dashboards) react to AR billing.
 */
export const INVOICE_POSTED_EVENT = 'invoice.posted';

/**
 * Domain event emitted when a customer receipt is recorded (atomically with the
 * receipt + its allocations). Payload:
 *   { receiptNo, customerId, amount, allocated, invoiceIds }.
 */
export const PAYMENT_RECEIVED_EVENT = 'payment.received';
