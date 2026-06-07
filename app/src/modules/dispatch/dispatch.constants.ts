/** Domain constants for the Dispatch module (M11). */

/**
 * Dispatch lifecycle. The base table log.dispatch (db/04) ships a `status`
 * column with the states READY/GATE_PASS/DISPATCHED/DELIVERED; migration 013
 * replaces that CHECK with this multi-gate release lifecycle:
 *   DRAFT     -> (both gates cleared) -> RELEASED -> DELIVERED
 * A dispatch can only be RELEASED once BOTH clearance gates are open:
 *   - QUALITY    clearance (QC / FAT quality sign-off)         — quality_cleared_*
 *   - COMMERCIAL clearance (Finance / payment & credit gate)   — commercial_cleared_*
 * This is the classic ETO "multi-gate release" (Quality + Commercial): never
 * ship before the payment milestone is secured. RELEASED emits 'dispatch.released'
 * (warranty start + billing downstream). DELIVERED / CANCELLED are terminal.
 */
export const DISPATCH_STATUS = [
  'DRAFT', 'RELEASED', 'DELIVERED', 'CANCELLED',
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUS)[number];

/** The two independent clearance gates that must both be open to release. */
export const GATE = { QUALITY: 'QUALITY', COMMERCIAL: 'COMMERCIAL' } as const;
export type Gate = (typeof GATE)[keyof typeof GATE];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
  DRAFT: ['RELEASED', 'CANCELLED'],
  RELEASED: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransition(from: DispatchStatus, to: DispatchStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * RBAC permission codes for this module (mirror sec.permission, db/08):
 *   STORES  = VCEX (create/prepare + release the shipment),
 *   QC      = VA   (quality clearance gate, DISPATCH.APPROVE),
 *   FINANCE = VAX  (commercial/payment clearance gate, DISPATCH.APPROVE).
 * Both clearance actions are guarded by DISPATCH.APPROVE; QC and FINANCE each
 * hold it, so the two gates are role-separated operationally while sharing the
 * approve permission.
 */
export const DISPATCH_PERMS = {
  VIEW: 'DISPATCH.VIEW',
  CREATE: 'DISPATCH.CREATE',
  EDIT: 'DISPATCH.EDIT',
  DELETE: 'DISPATCH.DELETE',
  APPROVE: 'DISPATCH.APPROVE',
  EXPORT: 'DISPATCH.EXPORT',
} as const;

/** Document-numbering type seeded in mdm.numbering_rule (prefix 'DSP', pad 6). */
export const DOC_TYPE = 'DISPATCH';

/**
 * Domain event emitted when a dispatch is RELEASED (both gates cleared).
 * Downstream consumers start the warranty clock and raise the billing milestone.
 */
export const DISPATCH_RELEASED_EVENT = 'dispatch.released';
