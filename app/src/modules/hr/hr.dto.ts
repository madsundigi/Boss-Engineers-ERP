import { z } from 'zod';
import { EMPLOYEE_STATUS, LEAVE_STATUS } from './hr.constants';

const t = (n: number) => z.string().trim().max(n);
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

// ---- Employee --------------------------------------------------------

/**
 * POST /api/hr/employees — create an employee in the caller's company.
 * emp_code is unique per company (enforced in the service over the company
 * roster). Cost/billing rates default to 0 (per-hour; feed project cost, M15).
 */
export const createEmployeeSchema = z.object({
  empCode: t(20).min(1, 'An employee code is required'),
  fullName: t(120).min(1, 'A full name is required'),
  departmentId: z.coerce.number().int().positive().optional(),
  designationId: z.coerce.number().int().positive().optional(),
  buId: z.coerce.number().int().positive().optional(),
  costRate: z.coerce.number().min(0).optional(),
  billingRate: z.coerce.number().min(0).optional(),
  doj: isoDate.optional(),
  status: z.enum(EMPLOYEE_STATUS).default('ACTIVE'),
});
export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;

/** PATCH /api/hr/employees/:id — edit master fields under optimistic lock. */
export const updateEmployeeSchema = z.object({
  fullName: t(120).min(1).optional(),
  departmentId: z.coerce.number().int().positive().nullable().optional(),
  designationId: z.coerce.number().int().positive().nullable().optional(),
  buId: z.coerce.number().int().positive().nullable().optional(),
  costRate: z.coerce.number().min(0).optional(),
  billingRate: z.coerce.number().min(0).optional(),
  doj: isoDate.optional(),
  status: z.enum(EMPLOYEE_STATUS).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type UpdateEmployeeDto = z.infer<typeof updateEmployeeSchema>;

/** GET /api/hr/employees — list filters + pagination (all from the query string). */
export const listEmployeesSchema = z.object({
  status: z.enum(EMPLOYEE_STATUS).optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  q: t(120).optional(), // free-text on emp_code / full_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['emp_code', 'full_name', 'status', 'doj']).default('emp_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListEmployeesDto = z.infer<typeof listEmployeesSchema>;

// ---- Department / Designation (reference data) -----------------------

export const createDepartmentSchema = z.object({
  deptCode: t(20).min(1, 'A department code is required'),
  deptName: t(80).min(1, 'A department name is required'),
});
export type CreateDepartmentDto = z.infer<typeof createDepartmentSchema>;

export const createDesignationSchema = z.object({
  desigCode: t(20).min(1, 'A designation code is required'),
  desigName: t(80).min(1, 'A designation name is required'),
});
export type CreateDesignationDto = z.infer<typeof createDesignationSchema>;

// ---- Leave -----------------------------------------------------------

/**
 * POST /api/hr/leaves — apply for leave. The day count is computed server-side
 * from the (inclusive) date range; the application opens in PENDING.
 */
export const applyLeaveSchema = z.object({
  employeeId: z.coerce.number().int().positive(),
  fromDate: isoDate,
  toDate: isoDate,
  leaveType: t(20).optional(),
  reason: t(300).optional(),
}).refine((v) => v.toDate >= v.fromDate, {
  message: 'toDate must be on or after fromDate',
  path: ['toDate'],
});
export type ApplyLeaveDto = z.infer<typeof applyLeaveSchema>;

/** POST /api/hr/leaves/:id/approve — optimistic-concurrency body only. */
export const approveLeaveSchema = z.object({
  rowVersion: z.coerce.number().int().positive(),
});
export type ApproveLeaveDto = z.infer<typeof approveLeaveSchema>;

/** POST /api/hr/leaves/:id/reject — reason is mandatory. */
export const rejectLeaveSchema = z.object({
  reason: t(300).min(1, 'A reason is required to reject'),
  rowVersion: z.coerce.number().int().positive(),
});
export type RejectLeaveDto = z.infer<typeof rejectLeaveSchema>;

/** GET /api/hr/leaves — list filters + pagination. */
export const listLeavesSchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  status: z.enum(LEAVE_STATUS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['from_date', 'status', 'leave_id']).default('from_date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListLeavesDto = z.infer<typeof listLeavesSchema>;

// ---- Attendance ------------------------------------------------------

/** GET /api/hr/attendance — month attendance summary (worked hours + leave days). */
export const attendanceQuerySchema = z.object({
  month: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM'),
  employeeId: z.coerce.number().int().positive().optional(),
});
export type AttendanceQueryDto = z.infer<typeof attendanceQuerySchema>;
