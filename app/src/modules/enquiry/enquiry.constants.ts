/** Domain constants for the Customer Enquiry module (M01). */

export const ENQUIRY_STATUS = ['NEW', 'QUALIFIED', 'QUOTED', 'CONVERTED', 'LOST', 'ON_HOLD'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUS)[number];

export const ENQUIRY_SOURCE = ['EMAIL', 'WEB', 'PHONE', 'WALKIN', 'REP', 'REFERRAL', 'EXHIBITION', 'OTHER'] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCE)[number];

/** Allowed status transitions (lead lifecycle). Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<EnquiryStatus, EnquiryStatus[]> = {
  NEW: ['QUALIFIED', 'ON_HOLD', 'LOST'],
  QUALIFIED: ['QUOTED', 'ON_HOLD', 'LOST'],
  QUOTED: ['CONVERTED', 'LOST'],
  ON_HOLD: ['NEW', 'QUALIFIED', 'LOST'],
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
