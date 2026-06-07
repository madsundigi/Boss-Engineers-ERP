/** Domain constants for the Employee Workload module (M07). */

/** Resource-allocation lifecycle (mirrors hcm.resource_allocation.ck_alloc_status). */
export const ALLOCATION_STATUS = ['PLANNED', 'CONFIRMED', 'CANCELLED'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUS)[number];

/** Timesheet lifecycle (mirrors hcm.timesheet.ck_ts_status). */
export const TIMESHEET_STATUS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUS)[number];

/**
 * Standard working hours per calendar day. Used as the fallback daily capacity
 * when no hcm.capacity_calendar row exists for an employee/date, so the
 * capacity-vs-load over-allocation check still has a baseline to compare against.
 */
export const DEFAULT_DAILY_CAPACITY_HOURS = 8;

/**
 * RBAC permission codes for this module (mirror sec.permission perm_code).
 * WORKLOAD.* governs allocations; TIMESHEET.* governs timesheets.
 * Seeded in db/08_rbac.sql: HR has WORKLOAD VCEAX; PLANNING has WORKLOAD VCEX;
 * PRODUCTION/PLANNING/HR hold TIMESHEET.APPROVE; SALES has no WORKLOAD perm.
 */
export const WORKLOAD_PERMS = {
  VIEW: 'WORKLOAD.VIEW',
  CREATE: 'WORKLOAD.CREATE',
  EDIT: 'WORKLOAD.EDIT',
  EXPORT: 'WORKLOAD.EXPORT',
} as const;

export const TIMESHEET_PERMS = {
  VIEW: 'TIMESHEET.VIEW',
  CREATE: 'TIMESHEET.CREATE',
  EDIT: 'TIMESHEET.EDIT',
  APPROVE: 'TIMESHEET.APPROVE',
  EXPORT: 'TIMESHEET.EXPORT',
} as const;
