import { z } from 'zod';
import { ALLOCATION_STATUS, ALLOCATION_REF_TYPE } from './workload.constants';

const id = z.coerce.number().int().positive();
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD)');
const hours = z.coerce.number().positive().max(24, 'Hours must be between 0 and 24');

/** POST /allocations — assign a person to a project (and optionally a task) for a day. */
export const createAllocationSchema = z.object({
  employeeId: id,
  projectId: id,
  taskId: id.optional(),
  allocDate: isoDate,
  plannedHours: z.coerce.number().positive().max(24, 'Planned hours must be between 0 and 24'),
  // Optional generic link to the downstream work item this allocation serves
  // (Production work-order / FAT / Installation). Both-or-neither (see refine).
  refType: z.enum(ALLOCATION_REF_TYPE).optional(),
  refId: z.coerce.number().int().positive().optional(),
  // status is server-defaulted to PLANNED on create; not accepted from the client
}).refine((d) => (d.refType == null) === (d.refId == null), {
  message: 'refType and refId must be provided together',
  path: ['refId'],
});
export type CreateAllocationDto = z.infer<typeof createAllocationSchema>;

/** GET /allocations — list filters + pagination (all from query string). */
export const listAllocationsSchema = z.object({
  employeeId: id.optional(),
  projectId: id.optional(),
  status: z.enum(ALLOCATION_STATUS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['alloc_date', 'employee_id', 'project_id', 'planned_hours']).default('alloc_date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListAllocationsDto = z.infer<typeof listAllocationsSchema>;

/** GET /allocations/capacity — capacity-vs-load window (over-allocation flagging). */
export const capacityQuerySchema = z.object({
  employeeId: id.optional(),
  from: isoDate,
  to: isoDate,
});
export type CapacityQueryDto = z.infer<typeof capacityQuerySchema>;

const timesheetLineSchema = z.object({
  projectId: id,
  wbsId: id.optional(),
  workDate: isoDate,
  hours,
});

/** POST /timesheets — a period of hours per project/WBS for one employee. */
export const createTimesheetSchema = z.object({
  employeeId: id,
  periodStart: isoDate,
  periodEnd: isoDate,
  lines: z.array(timesheetLineSchema).min(1, 'At least one timesheet line is required'),
});
export type CreateTimesheetDto = z.infer<typeof createTimesheetSchema>;

/** POST /timesheets/:id/approve — timesheet sign-off (TIMESHEET.APPROVE). */
export const approveTimesheetSchema = z.object({
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type ApproveTimesheetDto = z.infer<typeof approveTimesheetSchema>;
