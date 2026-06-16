/**
 * Domain constants for the Enquiry Follow-up trail.
 *
 * Each enquiry has a sequential follow-up trail (1..N). A follow-up is either
 * VIRTUAL (over a channel) or PHYSICAL (a meeting at a location), scheduled for a
 * date, then closed out PENDING -> DONE | CANCELLED. "MISSED" is NOT a stored
 * status — it is DERIVED on read when a still-PENDING follow-up's scheduled_date
 * has passed (see the urgency CASE in the repository).
 *
 * RBAC: this module owns the follow-up trail but reuses the ENQUIRY permissions
 * (no new permission codes are seeded) — VIEW for reads, EDIT for writes.
 */

export const FOLLOWUP_TYPE = ['VIRTUAL', 'PHYSICAL'] as const;
export type FollowupType = (typeof FOLLOWUP_TYPE)[number];

export const FOLLOWUP_CHANNEL = ['WHATSAPP', 'EMAIL', 'PHONE', 'VIDEO', 'OTHER'] as const;
export type FollowupChannel = (typeof FOLLOWUP_CHANNEL)[number];

/** Persisted statuses (MISSED is derived on read, never stored). */
export const FOLLOWUP_STATUS = ['PENDING', 'DONE', 'CANCELLED'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUS)[number];

/** Computed alert level returned on every read (see the urgency CASE in SQL). */
export const FOLLOWUP_URGENCY = ['DONE', 'CANCELLED', 'MISSED', 'DUE', 'UPCOMING', 'NORMAL'] as const;
export type FollowupUrgency = (typeof FOLLOWUP_URGENCY)[number];

/** Reuse the Enquiry RBAC codes — VIEW for reads, EDIT for writes. */
export const FOLLOWUP_PERMS = {
  VIEW: 'ENQUIRY.VIEW',
  EDIT: 'ENQUIRY.EDIT',
} as const;
