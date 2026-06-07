/** Domain constants for the Accounts Payable module (Vendor Invoices & Payments). */

/**
 * Vendor-invoice lifecycle (the 3-way-match flow). The base table
 * fin.vendor_invoice (db/05) already ships a status CHECK with exactly these
 * five states, so migration 021 does NOT touch the CHECK — it only adds the
 * row_version / soft-delete / audit columns the table lacks.
 *
 *   PENDING  -> MATCHED   : the 3-way match (PO / GRN / invoice) is satisfied
 *   MATCHED  -> APPROVED  : Finance approves the bill for payment (emits event)
 *   APPROVED -> PAID      : Σ vendor_payments >= total_amount (driven by payments)
 *   * -> DISPUTED         : any non-PAID invoice can be put into dispute
 *
 * PAID and DISPUTED are terminal here (no onward transition is modelled).
 */
export const VENDOR_INVOICE_STATUS = [
  'PENDING', 'MATCHED', 'APPROVED', 'PAID', 'DISPUTED',
] as const;
export type VendorInvoiceStatus = (typeof VENDOR_INVOICE_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<VendorInvoiceStatus, VendorInvoiceStatus[]> = {
  PENDING: ['MATCHED', 'DISPUTED'],
  MATCHED: ['APPROVED', 'DISPUTED'],
  APPROVED: ['PAID', 'DISPUTED'],
  PAID: [], // terminal
  DISPUTED: [], // terminal
};

export function canTransition(from: VendorInvoiceStatus, to: VendorInvoiceStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * RBAC permission codes for this module (mirror sec.permission, db/08 — the
 * AP_INVOICE module x {VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT} is seeded there;
 * grants re-asserted by migration 021). create + record-payment -> AP_INVOICE.CREATE;
 * match / update / dispute -> AP_INVOICE.EDIT; approve -> AP_INVOICE.APPROVE; every
 * read -> AP_INVOICE.VIEW; soft-delete -> AP_INVOICE.DELETE; CSV -> AP_INVOICE.EXPORT.
 */
export const AP_PERMS = {
  VIEW: 'AP_INVOICE.VIEW',
  CREATE: 'AP_INVOICE.CREATE',
  EDIT: 'AP_INVOICE.EDIT',
  DELETE: 'AP_INVOICE.DELETE',
  APPROVE: 'AP_INVOICE.APPROVE',
  EXPORT: 'AP_INVOICE.EXPORT',
} as const;

/** Outbox aggregate type for vendor-invoice domain events. */
export const VENDOR_INVOICE_AGGREGATE = 'VENDOR_INVOICE';

/**
 * Document-numbering type for vendor PAYMENTS, registered in mdm.numbering_rule
 * by migration 021 (prefix 'VPY', pad 6). NOTE: there is no numbering rule for
 * the vendor INVOICE — vinv_no is the supplier's own invoice number, supplied by
 * the user, not auto-generated.
 */
export const PAYMENT_DOC_TYPE = 'VPAY';

/**
 * Domain event emitted when a vendor invoice is APPROVED (atomically with the
 * state change via the transactional outbox). Payload: { vinvNo, vendorId,
 * totalAmount }. Downstream consumers (AP ageing / cash-flow / GL accrual) react.
 */
export const VENDOR_INVOICE_APPROVED_EVENT = 'vendor_invoice.approved';
