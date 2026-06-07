/** Domain constants for the Installation & Commissioning module (M12). */

/**
 * Installation lifecycle. The base table svc.installation (db/04) already ships a
 * `status` CHECK with every state below, so (unlike dispatch) migration 014 does
 * NOT replace it. The site/commissioning flow is:
 *   PLANNED      -> (work started on site)            -> IN_PROGRESS
 *   IN_PROGRESS  -> (SAT performed; PASS/FAIL stamped)-> COMMISSIONED
 *   COMMISSIONED -> (customer signs acceptance)       -> ACCEPTED
 *   ACCEPTED     -> (handover complete)               -> CLOSED
 * ACCEPTED is gated: it requires a PASSED SAT and zero OPEN punch items, and it
 * emits 'installation.accepted' (warranty clock start downstream). CLOSED is
 * terminal. CANCELLED is NOT in the base CHECK and is deliberately absent here.
 */
export const INSTALLATION_STATUS = [
  'PLANNED', 'IN_PROGRESS', 'COMMISSIONED', 'ACCEPTED', 'CLOSED',
] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUS)[number];

/** Site Acceptance Test outcome (svc.installation.sat_result CHECK, db/04). */
export const SAT_RESULT = ['PASS', 'FAIL', 'PENDING'] as const;
export type SatResult = (typeof SAT_RESULT)[number];

/** Punch-item status (qms.punch_item CHECK, db/04). An OPEN item blocks acceptance. */
export const PUNCH_STATUS = ['OPEN', 'CLOSED'] as const;
export type PunchStatus = (typeof PUNCH_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<InstallationStatus, InstallationStatus[]> = {
  PLANNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['COMMISSIONED'],
  COMMISSIONED: ['ACCEPTED'],
  ACCEPTED: ['CLOSED'],
  CLOSED: [], // terminal
};

export function canTransition(from: InstallationStatus, to: InstallationStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * RBAC permission codes for this module (mirror sec.permission, db/08):
 *   INSTALL role holds VCEDAX (all). VIEW is also held by ADMIN, CEO, FINANCE,
 *   PLANNING, PRODUCTION, QC, SALES, SERVICE. APPROVE guards the acceptance /
 *   sign-off action; the INSTALL role is the only one with both CREATE + APPROVE.
 */
export const INSTALLATION_PERMS = {
  VIEW: 'INSTALLATION.VIEW',
  CREATE: 'INSTALLATION.CREATE',
  EDIT: 'INSTALLATION.EDIT',
  DELETE: 'INSTALLATION.DELETE',
  APPROVE: 'INSTALLATION.APPROVE',
  EXPORT: 'INSTALLATION.EXPORT',
} as const;

/** Document-numbering type seeded in mdm.numbering_rule (prefix 'INST', pad 5). */
export const DOC_TYPE = 'INSTALL';

/**
 * Domain event emitted when an installation is ACCEPTED (customer sign-off).
 * Downstream consumers start the warranty clock. Payload: { installNo, projectId,
 * dispatchId }.
 */
export const INSTALLATION_ACCEPTED_EVENT = 'installation.accepted';
