/** Domain constants for the GST / Tax module (India statutory). */

/**
 * Two surfaces here:
 *   * mdm.tax_code      — a GLOBAL GST-rate master (no company_id, no RLS): the
 *                         CGST/SGST/IGST rate catalog. This module provides CRUD
 *                         to populate it (the table ships empty). Simple master:
 *                         no row_version / soft-delete.
 *   * fin.tax_transaction — a per-company, APPEND-ONLY GST ledger (the GSTR-style
 *                         output-tax register). One immutable row per taxed
 *                         document; corrections are new rows, never updates.
 * E-invoicing stamps the IRN / ack number (and, separately, the e-way bill number)
 * back onto fin.invoice — a table OWNED by the AR Billing module; this module only
 * reads its amounts and stamps those three columns.
 */

/**
 * RBAC permission codes (mirror the sec.permission catalog in db/08 — the TAX
 * module x {VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT} is already seeded there;
 * grants: FINANCE = VCEDAX (all six), CEO = VX (view + export), ADMIN = V (view)).
 * Route guards:
 *   createTaxCode / generateEInvoice / generateEwayBill -> TAX.CREATE
 *   setActive (flip a tax code on/off)                  -> TAX.EDIT
 *   every read (codes, transactions, GST summary)       -> TAX.VIEW
 *   CSV export of the GST register                      -> TAX.EXPORT
 */
export const TAX_PERMS = {
  VIEW: 'TAX.VIEW',
  CREATE: 'TAX.CREATE',
  EDIT: 'TAX.EDIT',
  DELETE: 'TAX.DELETE',
  APPROVE: 'TAX.APPROVE',
  EXPORT: 'TAX.EXPORT',
} as const;

/**
 * Place-of-supply classification that decides the GST split:
 *   INTRA (intra-state) -> CGST + SGST (each half the tax),
 *   INTER (inter-state) -> IGST (the whole tax).
 */
export const SUPPLY_TYPE = { INTRA: 'INTRA', INTER: 'INTER' } as const;
export type SupplyType = (typeof SUPPLY_TYPE)[keyof typeof SUPPLY_TYPE];
export const SUPPLY_TYPES = [SUPPLY_TYPE.INTRA, SUPPLY_TYPE.INTER] as const;

/** doc_type written into fin.tax_transaction for a customer (AR) invoice. */
export const TAX_DOC_TYPE_INVOICE = 'INVOICE';

/**
 * Invoice statuses (fin.invoice.status) for which an e-invoice may be raised.
 * A DRAFT is not yet a legal document and CANCELLED/PAID-flow states must not be
 * (re-)reported; POSTED or SENT is the e-invoice-eligible window.
 */
export const EINVOICE_ELIGIBLE_STATUS = ['POSTED', 'SENT'] as const;

/**
 * Domain event emitted (transactional outbox) when an e-invoice / IRN is
 * generated. Payload: { invoiceNo, irn, taxableAmount, totalTax }.
 */
export const EINVOICE_GENERATED_EVENT = 'einvoice.generated';

/**
 * Domain event emitted (transactional outbox) when an e-way bill is generated.
 * Payload: { invoiceNo, ewayBillNo }.
 */
export const EWAY_BILL_GENERATED_EVENT = 'eway_bill.generated';
