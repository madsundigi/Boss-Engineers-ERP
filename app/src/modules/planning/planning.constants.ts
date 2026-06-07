/** Domain constants for the Project Planning & Gantt module (M04). */

/**
 * Task dependency types — the four classic precedence relations on a Gantt
 * (proj.task_dependency.ck_dep_type): Finish-to-Start, Start-to-Start,
 * Finish-to-Finish, Start-to-Finish. FS is the default.
 */
export const DEP_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;
export type DepType = (typeof DEP_TYPES)[number];

/**
 * Milestone lifecycle (proj.milestone.ck_milestone_status). A milestone is
 * PENDING until ACHIEVED; payment milestones then move BILLED -> PAID downstream.
 */
export const MILESTONE_STATUS = ['PENDING', 'ACHIEVED', 'BILLED', 'PAID'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUS)[number];

/** RBAC permission codes for this module (mirror sec.permission; PLANNING=VCEDAX). */
export const PLANNING_PERMS = {
  VIEW: 'PLANNING.VIEW',
  CREATE: 'PLANNING.CREATE',
  EDIT: 'PLANNING.EDIT',
  APPROVE: 'PLANNING.APPROVE',
  EXPORT: 'PLANNING.EXPORT',
} as const;

/** Domain event emitted when a baseline is approved (re-planning / EVM consumers). */
export const BASELINE_APPROVED_EVENT = 'planning.baseline.approved';
