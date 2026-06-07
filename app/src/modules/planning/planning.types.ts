import { DepType, MilestoneStatus } from './planning.constants';

/** A persisted WBS element (camelCase projection of proj.wbs_element). */
export interface WbsElement {
  wbsId: number;
  projectId: number;
  parentWbsId: number | null;
  wbsCode: string;
  wbsName: string;
  budgetAmount: number;
  isBillingMilestone: boolean;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

/** A task dependency edge (camelCase projection of proj.task_dependency). */
export interface TaskDependency {
  dependencyId?: number;
  predTaskId: number;
  depType: DepType;
  lagDays: number;
}

/** A persisted schedule task (camelCase projection of proj.task) plus its predecessors. */
export interface Task {
  taskId: number;
  projectId: number;
  wbsId: number | null;
  taskName: string;
  plannedStart: string;
  plannedEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  baselineStart: string | null;
  baselineEnd: string | null;
  percentComplete: number;
  isCriticalPath: boolean;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  /** Duration in calendar days, inclusive (planned_end - planned_start + 1). */
  durationDays: number;
  dependencies: TaskDependency[];
}

/** A persisted milestone (camelCase projection of proj.milestone). */
export interface Milestone {
  milestoneId: number;
  projectId: number;
  wbsId: number | null;
  name: string;
  plannedDate: string | null;
  actualDate: string | null;
  isPaymentMilestone: boolean;
  billPct: number | null;
  billAmount: number | null;
  status: MilestoneStatus;
}

/** A persisted baseline snapshot (camelCase projection of proj.baseline). */
export interface Baseline {
  baselineId: number;
  projectId: number;
  baselineNo: number;
  approvedBy: number | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface WbsListResult {
  rows: WbsElement[];
  total: number;
}

export interface TaskListResult {
  rows: Task[];
  total: number;
}

export interface MilestoneListResult {
  rows: Milestone[];
  total: number;
}
