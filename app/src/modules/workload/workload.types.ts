import { AllocationStatus, TimesheetStatus } from './workload.constants';

/** A persisted resource-allocation row (camelCase projection of hcm.resource_allocation). */
export interface Allocation {
  allocId: number;
  companyId: number;
  employeeId: number;
  employeeName: string | null;
  projectId: number;
  taskId: number | null;
  allocDate: string;
  plannedHours: number;
  status: AllocationStatus;
  rowVersion: number;
}

export interface AllocationListResult {
  rows: Allocation[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Capacity-vs-load roll-up for one employee on one day: the planned hours
 * already committed against the available capacity for that date. `overAllocated`
 * is true when committed load exceeds capacity (a bottleneck alert candidate).
 */
export interface CapacityLoad {
  employeeId: number;
  employeeName: string | null;
  allocDate: string;
  capacityHours: number;
  allocatedHours: number;
  overAllocated: boolean;
}

/** A persisted timesheet line (camelCase projection of hcm.timesheet_line). */
export interface TimesheetLine {
  tsLineId: number;
  projectId: number;
  wbsId: number | null;
  workDate: string;
  hours: number;
  costAmount: number;
}

/** A persisted timesheet header with its lines (hcm.timesheet + hcm.timesheet_line). */
export interface Timesheet {
  tsId: number;
  companyId: number;
  employeeId: number;
  employeeName: string | null;
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  submittedAt: string | null;
  approvedBy: number | null;
  approvedAt: string | null;
  rowVersion: number;
  totalHours: number;
  totalCost: number;
  lines: TimesheetLine[];
}
