import { EmployeeStatus, LeaveStatus } from './hr.constants';

/** A persisted employee row (camelCase projection of hcm.employee). */
export interface Employee {
  employeeId: number;
  companyId: number;
  empCode: string;
  fullName: string;
  departmentId: number | null;
  designationId: number | null;
  buId: number | null;
  costRate: number;
  billingRate: number;
  doj: string | null;
  status: EmployeeStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface EmployeeListResult {
  rows: Employee[];
  total: number;
  page: number;
  pageSize: number;
}

/** A department (camelCase projection of hcm.department). */
export interface Department {
  departmentId: number;
  companyId: number;
  deptCode: string;
  deptName: string;
}

/** A designation (camelCase projection of hcm.designation; company-global). */
export interface Designation {
  designationId: number;
  desigCode: string;
  desigName: string;
}

/** A leave application (camelCase projection of hcm.leave). */
export interface Leave {
  leaveId: number;
  employeeId: number;
  employeeName: string | null;
  fromDate: string;
  toDate: string;
  leaveType: string | null;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  approverId: number | null;
  approvedAt: string | null;
  rowVersion: number;
}

export interface LeaveListResult {
  rows: Leave[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Per-employee attendance summary for a month: the timesheet hours logged
 * (over hcm.timesheet_line, owned by Workload — read-only) and the approved
 * leave days that overlap the month (over hcm.leave). Read-only aggregate.
 */
export interface AttendanceSummary {
  employeeId: number;
  employeeName: string | null;
  month: string; // YYYY-MM
  workedHours: number;
  leaveDays: number;
}
