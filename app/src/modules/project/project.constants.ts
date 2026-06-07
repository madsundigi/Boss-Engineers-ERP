/** Domain constants for the Project Creation module (M03). */

/**
 * Project lifecycle. A project is born in PLANNING (charter draft), is gated by a
 * FINANCE/CEO charter + budget sign-off (APPROVED), then kicked off (ACTIVE). It
 * may be paused (ON_HOLD) and resumed, completed (DELIVERED), and finally CLOSED.
 * CANCELLED is reachable from any non-terminal state. The DB ck check carries the
 * same set (migration 006 extends the base check to include APPROVED).
 */
export const PROJECT_STATUS = [
  'PLANNING', 'APPROVED', 'ACTIVE', 'ON_HOLD', 'DELIVERED', 'CLOSED', 'CANCELLED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUS)[number];

export const HEALTH_RAG = ['R', 'A', 'G'] as const;
export type HealthRag = (typeof HEALTH_RAG)[number];

/** Allowed status transitions (charter -> execution lifecycle). Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  PLANNING: ['ACTIVE', 'CANCELLED'], // ACTIVE only via /approve (charter sign-off); CANCELLED directly
  APPROVED: ['ACTIVE', 'ON_HOLD', 'CANCELLED'],
  ACTIVE: ['ON_HOLD', 'DELIVERED', 'CANCELLED'],
  ON_HOLD: ['ACTIVE', 'CANCELLED'],
  DELIVERED: ['CLOSED'],
  CLOSED: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** A project may only be edited while it is still in the charter (pre-kickoff) phase. */
export function isEditable(status: ProjectStatus): boolean {
  return status === 'PLANNING' || status === 'APPROVED';
}

/** Terminal states cannot transition or be cancelled. */
export function isTerminal(status: ProjectStatus): boolean {
  return status === 'CLOSED' || status === 'CANCELLED';
}

/** RBAC permission codes for this module (mirror sec.permission). */
export const PROJECT_PERMS = {
  VIEW: 'PROJECT.VIEW',
  CREATE: 'PROJECT.CREATE',
  EDIT: 'PROJECT.EDIT',
  APPROVE: 'PROJECT.APPROVE',
  EXPORT: 'PROJECT.EXPORT',
} as const;

export const DOC_TYPE = 'PROJECT';
