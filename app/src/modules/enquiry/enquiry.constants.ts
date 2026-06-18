/** Domain constants for the Customer Enquiry module (M01). */

export const ENQUIRY_STATUS = ['NEW', 'QUALIFIED', 'QUOTED', 'REVISE_QUOTED', 'WON', 'LOST', 'ON_HOLD'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUS)[number];

export const ENQUIRY_SOURCE = ['EMAIL', 'WEB', 'PHONE', 'WALKIN', 'REP', 'REFERRAL', 'EXHIBITION', 'OTHER'] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCE)[number];

/**
 * Allowed status transitions (lead lifecycle). Deny anything not listed.
 *
 * Happy path: NEW -> QUALIFIED -> QUOTED -> WON. A QUOTED lead can bounce through
 * REVISE_QUOTED (re-quote round trip) before being won. Any ACTIVE stage
 * (NEW / QUALIFIED / QUOTED / REVISE_QUOTED) can be paused to ON_HOLD and resumed
 * back to an active stage, or marked LOST (a reason is required). Reaching WON
 * auto-seeds a Project (cross-module trigger). WON and LOST are terminal.
 */
export const STATUS_TRANSITIONS: Record<EnquiryStatus, EnquiryStatus[]> = {
  NEW: ['QUALIFIED', 'ON_HOLD', 'LOST'],
  QUALIFIED: ['QUOTED', 'ON_HOLD', 'LOST'],
  QUOTED: ['REVISE_QUOTED', 'WON', 'ON_HOLD', 'LOST'],         // re-quote, win, pause, or lose
  REVISE_QUOTED: ['QUOTED', 'WON', 'ON_HOLD', 'LOST'],         // back to QUOTED, or win/pause/lose
  WON: [], // terminal (a Project has been seeded)
  LOST: [], // terminal (a reason is required)
  ON_HOLD: ['NEW', 'QUALIFIED', 'QUOTED', 'REVISE_QUOTED', 'LOST'], // resume to any active stage
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
