/** Domain constants for the Production / Work Order module (M08). */

/**
 * Work-order lifecycle. A WO is planned (PLANNED), released to the shop floor
 * (RELEASED — gated on material readiness + WORK_ORDER.APPROVE), starts when the
 * first production is confirmed (IN_PROGRESS), and is finished with its as-built
 * serials (COMPLETED). It may be paused (ON_HOLD) and resumed, and CANCELLED from
 * any non-terminal state. CLOSED is the post-completion accounting close.
 * The base check (db/03 ck_wo_status) already carries PLANNED/RELEASED/
 * IN_PROGRESS/COMPLETED/CLOSED/CANCELLED; migration 012 adds ON_HOLD.
 */
export const WO_STATUS = [
  'PLANNED', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD', 'CLOSED', 'CANCELLED',
] as const;
export type WoStatus = (typeof WO_STATUS)[number];

/** Per-operation status (mfg.work_order_operation.ck_wo_op_status). */
export const WO_OP_STATUS = ['PENDING', 'IN_PROGRESS', 'DONE'] as const;
export type WoOpStatus = (typeof WO_OP_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<WoStatus, WoStatus[]> = {
  PLANNED: ['RELEASED', 'CANCELLED'], // RELEASED only via /release (approval gate)
  RELEASED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'ON_HOLD', 'CANCELLED'], // COMPLETED only via /complete
  ON_HOLD: ['RELEASED', 'IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['CLOSED'],
  CLOSED: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransition(from: WoStatus, to: WoStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** A WO's plan (header + operations + material) may only be edited pre-release. */
export function isEditable(status: WoStatus): boolean {
  return status === 'PLANNED';
}

/** Terminal states cannot transition or be cancelled. */
export function isTerminal(status: WoStatus): boolean {
  return status === 'CLOSED' || status === 'CANCELLED';
}

/** RBAC permission codes for this module (mirror sec.permission; db/08 seeds these). */
export const WO_PERMS = {
  VIEW: 'WORK_ORDER.VIEW',
  CREATE: 'WORK_ORDER.CREATE',
  EDIT: 'WORK_ORDER.EDIT',
  APPROVE: 'WORK_ORDER.APPROVE',
  EXPORT: 'WORK_ORDER.EXPORT',
} as const;

/** Document-numbering type seeded in mdm.numbering_rule by migration 012 (prefix 'WO'). */
export const DOC_TYPE = 'WORK_ORDER';

/** Domain event emitted when a WO is released to the shop floor. */
export const WO_RELEASED_EVENT = 'workorder.released';

/** Domain event emitted when a WO is completed (as-built recorded). */
export const WO_COMPLETED_EVENT = 'workorder.completed';
