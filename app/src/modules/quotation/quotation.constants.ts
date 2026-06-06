/** Domain constants for the Quotation module (M02). */

export const QUOTE_STATUS = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SENT', 'NEGOTIATION', 'WON', 'LOST',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUS)[number];

/** Approval policy (illustrative DOA thresholds; configurable). */
export const MIN_MARGIN_PCT = 15;
export const MAX_DISCOUNT_PCT = 10;

/** A quote needs higher-DOA approval when margin is thin or discount is deep. */
export function requiresApproval(marginPct: number, discountPct: number): boolean {
  return marginPct < MIN_MARGIN_PCT || discountPct > MAX_DISCOUNT_PCT;
}

export const QUOTE_PERMS = {
  VIEW: 'QUOTATION.VIEW',
  CREATE: 'QUOTATION.CREATE',
  EDIT: 'QUOTATION.EDIT',
  DELETE: 'QUOTATION.DELETE',
  APPROVE: 'QUOTATION.APPROVE',
  EXPORT: 'QUOTATION.EXPORT',
} as const;

export const DOC_TYPE = 'QUOTATION';

/** A1, A2 … revision labels from a 0-based rev number. */
export function revisionLabel(revNo: number): string {
  return `Rev ${String.fromCharCode(65 + (revNo % 26))}`;
}
