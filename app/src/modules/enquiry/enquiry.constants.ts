/** Domain constants for the Customer Enquiry module (M01). */

export const ENQUIRY_STATUS = ['NEW', 'QUALIFIED', 'QUOTED', 'CONVERTED', 'LOST', 'ON_HOLD'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUS)[number];

export const ENQUIRY_SOURCE = ['EMAIL', 'WEB', 'PHONE', 'WALKIN', 'REP', 'REFERRAL', 'EXHIBITION', 'OTHER'] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCE)[number];

/**
 * Allowed status transitions (lead lifecycle). Deny anything not listed.
 *
 * Happy path: NEW -> QUALIFIED -> QUOTED -> CONVERTED. Any ACTIVE stage
 * (NEW / QUALIFIED / QUOTED) can be paused to ON_HOLD and resumed back to any
 * active stage, or marked LOST (a reason is required). CONVERTED and LOST are
 * terminal.
 */
export const STATUS_TRANSITIONS: Record<EnquiryStatus, EnquiryStatus[]> = {
  NEW: ['QUALIFIED', 'ON_HOLD', 'LOST'],
  QUALIFIED: ['QUOTED', 'ON_HOLD', 'LOST'],
  QUOTED: ['CONVERTED', 'ON_HOLD', 'LOST'],          // a sent quote can be paused
  ON_HOLD: ['NEW', 'QUALIFIED', 'QUOTED', 'LOST'],   // resume to any active stage
  CONVERTED: [], // terminal
  LOST: [], // terminal
};

export function canTransition(from: EnquiryStatus, to: EnquiryStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** RBAC permission codes for this module (mirror sec.permission). */
export const ENQUIRY_PERMS = {
  VIEW: 'ENQUIRY.VIEW',
  CREATE: 'ENQUIRY.CREATE',
  EDIT: 'ENQUIRY.EDIT',
  DELETE: 'ENQUIRY.DELETE',
  APPROVE: 'ENQUIRY.APPROVE',
  EXPORT: 'ENQUIRY.EXPORT',
} as const;

export const DOC_TYPE = 'ENQUIRY';
