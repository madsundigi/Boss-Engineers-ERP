/** Domain constants for the Factory Acceptance Test module (M10). */

/**
 * FAT lifecycle. The base table qms.fat_execution (db/04) ships only a `result`
 * column (PASS/FAIL/CONDITIONAL); migration 009 adds this user-facing `status`
 * lifecycle column so an execution can be scheduled, run, and signed off:
 *   SCHEDULED  -> IN_PROGRESS  (results are recorded)
 *   IN_PROGRESS -> PASSED|FAILED (result PASS/FAIL is set; failures raise a punch list)
 *   PASSED     -> CLEARED      (customer/QC sign-off; the Dispatch-clearance gate)
 * CLEARED / CANCELLED are terminal.
 */
export const FAT_STATUS = [
  'SCHEDULED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'CLEARED', 'CANCELLED',
] as const;
export type FatStatus = (typeof FAT_STATUS)[number];

/** Outcome recorded on the base `result` column (qms.fat_execution.ck_fat_result). */
export const FAT_RESULT = ['PASS', 'FAIL', 'CONDITIONAL'] as const;
export type FatResult = (typeof FAT_RESULT)[number];

/** Per-parameter pass/fail of a measured value (qms.fat_result_line.ck_result_pf). */
export const RESULT_PF = ['PASS', 'FAIL'] as const;
export type ResultPassFail = (typeof RESULT_PF)[number];

/** Punch-item severity + status (qms.punch_item). */
export const PUNCH_SEVERITY = ['LOW', 'MED', 'HIGH', 'CRITICAL'] as const;
export type PunchSeverity = (typeof PUNCH_SEVERITY)[number];

/** The state that clears the Dispatch gate (log.dispatch.fat_id references a CLEARED FAT). */
export const DISPATCH_CLEARANCE_STATUS: FatStatus = 'CLEARED';

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<FatStatus, FatStatus[]> = {
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['PASSED', 'FAILED', 'CANCELLED'],
  PASSED: ['CLEARED', 'IN_PROGRESS'], // re-open to re-test if needed
  FAILED: ['IN_PROGRESS', 'CANCELLED'], // re-test after punch items are addressed
  CLEARED: [], // terminal — gate is open for Dispatch
  CANCELLED: [], // terminal
};

export function canTransition(from: FatStatus, to: FatStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** RBAC permission codes for this module (mirror sec.permission; QC=VCEDAX, SALES=V). */
export const FAT_PERMS = {
  VIEW: 'FAT.VIEW',
  CREATE: 'FAT.CREATE',
  EDIT: 'FAT.EDIT',
  DELETE: 'FAT.DELETE',
  APPROVE: 'FAT.APPROVE',
  EXPORT: 'FAT.EXPORT',
} as const;

/** Document-numbering type seeded in mdm.numbering_rule (prefix 'FAT', pad 5). */
export const DOC_TYPE = 'FAT';

/** Domain event emitted when a FAT is signed off — Dispatch consumes this gate. */
export const FAT_PASSED_EVENT = 'fat.passed';
