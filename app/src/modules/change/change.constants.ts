/** Domain constants for the Change / Variation Management module (Tier-1 gap #5). */

/**
 * Change-order (engineering / scope variation) lifecycle. The base table
 * proj.change_order (db/02) ships a `status` column with the states
 * DRAFT/PENDING/CUSTOMER_APPROVED/REJECTED; migration 025 replaces that CHECK
 * with this formal re-cost / re-baseline approval lifecycle:
 *   DRAFT -> SUBMITTED -> APPROVED | REJECTED -> IMPLEMENTED  (+ CANCELLED)
 * A change order captures the cost / price (revenue) / schedule impact of a
 * scope variation. APPROVED requires Segregation of Duties (the approver must
 * differ from the creator) and emits 'change_order.approved' so the
 * Profitability / Planning modules can re-cost and re-baseline the project.
 * IMPLEMENTED and REJECTED / CANCELLED are terminal.
 */
export const CHANGE_STATUS = [
  'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'IMPLEMENTED', 'CANCELLED',
] as const;
export type ChangeStatus = (typeof CHANGE_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['IMPLEMENTED', 'CANCELLED'],
  REJECTED: [], // terminal
  IMPLEMENTED: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * RBAC permission codes for this module (mirror sec.permission):
 *   CREATE  -> PLANNING, SALES        (raise a variation)
 *   EDIT    -> PLANNING               (amend a DRAFT, submit it)
 *   APPROVE -> CEO, FINANCE           (approve / reject a SUBMITTED variation)
 *   VIEW    -> ADMIN,CEO,FINANCE,PLANNING,PRODUCTION,SALES
 *   EXPORT  -> CEO, FINANCE, PLANNING
 * Approve is role-separated from create operationally, and a per-row SoD check
 * additionally blocks a user from approving a change order they created.
 */
export const CHANGE_PERMS = {
  VIEW: 'CHANGE_ORDER.VIEW',
  CREATE: 'CHANGE_ORDER.CREATE',
  EDIT: 'CHANGE_ORDER.EDIT',
  DELETE: 'CHANGE_ORDER.DELETE',
  APPROVE: 'CHANGE_ORDER.APPROVE',
  EXPORT: 'CHANGE_ORDER.EXPORT',
} as const;

/** Document-numbering type registered in mdm.numbering_rule (prefix 'CO', pad 6). */
export const DOC_TYPE = 'CHANGE_ORDER';

/**
 * Domain event emitted when a change order is APPROVED. Downstream consumers
 * (M15 Project Profitability, Planning) re-cost and re-baseline the project from
 * the cost / price impact carried in the payload.
 */
export const CHANGE_ORDER_APPROVED_EVENT = 'change_order.approved';
