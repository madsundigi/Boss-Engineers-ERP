/** Domain constants for the HRMS core module. */

/**
 * Employee lifecycle (mirrors hcm.employee.ck_emp_status, db/03). The base CHECK
 * allows ACTIVE/INACTIVE/LEFT; the HR self-service surface drives ACTIVE/INACTIVE
 * (a soft-delete sets is_deleted, it does not invent a LEFT transition here).
 */
export const EMPLOYEE_STATUS = ['ACTIVE', 'INACTIVE', 'LEFT'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[number];

/**
 * Leave-application lifecycle. The base table (db/03) ships PENDING/APPROVED/
 * REJECTED; migration 027 widens the CHECK to add CANCELLED.
 *   PENDING -> APPROVED | REJECTED   (HR/PLANNING approval, LEAVE.APPROVE)
 *   PENDING -> CANCELLED             (applicant withdraws)
 * APPROVED / REJECTED / CANCELLED are terminal.
 */
export const LEAVE_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUS)[number];

/** Allowed leave-status transitions. Deny anything not listed. */
export const LEAVE_TRANSITIONS: Record<LeaveStatus, LeaveStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [], // terminal
  REJECTED: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransitionLeave(from: LeaveStatus, to: LeaveStatus): boolean {
  return LEAVE_TRANSITIONS[from].includes(to);
}

/**
 * Inclusive whole-day count between two ISO dates (YYYY-MM-DD). A single-day
 * leave (from == to) is 1 day. Computed in the service so the day count is
 * deterministic and unit-testable without a database.
 */
export function leaveDays(fromDate: string, toDate: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  return Math.floor((to - from) / MS_PER_DAY) + 1;
}

/**
 * RBAC permission codes for this module (mirror sec.permission perm_code).
 * EMPLOYEE.* (db/08: HR/ADMIN VCEDX, CEO VX, PLANNING/FINANCE V) governs the
 * employee master AND the department/designation reference data + reads/export.
 * LEAVE.* is seeded by migration 027 (HR VCEDAX; PLANNING VA; PRODUCTION VC;
 * ADMIN/CEO/FINANCE V).
 */
export const EMPLOYEE_PERMS = {
  VIEW: 'EMPLOYEE.VIEW',
  CREATE: 'EMPLOYEE.CREATE',
  EDIT: 'EMPLOYEE.EDIT',
  DELETE: 'EMPLOYEE.DELETE',
  EXPORT: 'EMPLOYEE.EXPORT',
} as const;

export const LEAVE_PERMS = {
  VIEW: 'LEAVE.VIEW',
  CREATE: 'LEAVE.CREATE',
  EDIT: 'LEAVE.EDIT',
  DELETE: 'LEAVE.DELETE',
  APPROVE: 'LEAVE.APPROVE',
  EXPORT: 'LEAVE.EXPORT',
} as const;

/**
 * Domain event emitted when a leave application is APPROVED. Downstream
 * consumers can reflect the absence into capacity / payroll attendance.
 */
export const LEAVE_APPROVED_EVENT = 'leave.approved';
