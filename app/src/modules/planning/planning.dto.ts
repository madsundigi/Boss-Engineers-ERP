import { z } from 'zod';
import { DEP_TYPES, MILESTONE_STATUS } from './planning.constants';

const trimmed = (max: number) => z.string().trim().max(max);
const ymd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** POST /api/planning/projects/:projectId/wbs — a WBS element under a project. */
export const createWbsSchema = z.object({
  wbsCode: trimmed(40).min(1, 'WBS Code is required'),
  wbsName: trimmed(200).min(1, 'WBS Name is required'),
  parentWbsId: z.coerce.number().int().positive().optional(),
  budgetAmount: z.coerce.number().min(0).optional().default(0),
  isBillingMilestone: z.boolean().optional().default(false),
});
export type CreateWbsDto = z.infer<typeof createWbsSchema>;

/** A single predecessor edge on a task (FS/SS/FF/SF + lag in days). */
const dependencySchema = z.object({
  predTaskId: z.coerce.number().int().positive(),
  depType: z.enum(DEP_TYPES).optional().default('FS'),
  lagDays: z.coerce.number().int().optional().default(0),
});

/** POST /api/planning/projects/:projectId/tasks — a schedule activity. */
export const createTaskSchema = z.object({
  taskName: trimmed(200).min(1, 'Task Name is required'),
  wbsId: z.coerce.number().int().positive().optional(),
  plannedStart: ymd,
  plannedEnd: ymd,
  percentComplete: z.coerce.number().min(0).max(100).optional().default(0),
  dependencies: z.array(dependencySchema).max(200).optional(),
});
export type CreateTaskDto = z.infer<typeof createTaskSchema>;

/** PATCH /api/planning/tasks/:id — edit duration / dates / progress / dependencies. */
export const updateTaskSchema = z.object({
  taskName: trimmed(200).min(1).optional(),
  wbsId: z.coerce.number().int().positive().optional(),
  plannedStart: ymd.optional(),
  plannedEnd: ymd.optional(),
  actualStart: ymd.optional(),
  actualEnd: ymd.optional(),
  percentComplete: z.coerce.number().min(0).max(100).optional(),
  isCriticalPath: z.boolean().optional(),
  dependencies: z.array(dependencySchema).max(200).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;

/** POST /api/planning/projects/:projectId/milestones — a delivery / payment milestone. */
export const createMilestoneSchema = z.object({
  name: trimmed(150).min(1, 'Milestone name is required'),
  wbsId: z.coerce.number().int().positive().optional(),
  plannedDate: ymd.optional(),
  isPaymentMilestone: z.boolean().optional().default(false),
  billPct: z.coerce.number().min(0).max(100).optional(),
  billAmount: z.coerce.number().min(0).optional(),
});
export type CreateMilestoneDto = z.infer<typeof createMilestoneSchema>;

/** PATCH /api/planning/milestones/:id — update achievement / billing status. */
export const updateMilestoneSchema = z.object({
  name: trimmed(150).min(1).optional(),
  plannedDate: ymd.optional(),
  actualDate: ymd.optional(),
  status: z.enum(MILESTONE_STATUS).optional(),
  billPct: z.coerce.number().min(0).max(100).optional(),
  billAmount: z.coerce.number().min(0).optional(),
});
export type UpdateMilestoneDto = z.infer<typeof updateMilestoneSchema>;

/** POST /api/planning/projects/:projectId/baseline — snapshot the current schedule. */
export const createBaselineSchema = z.object({}).strip();
export type CreateBaselineDto = z.infer<typeof createBaselineSchema>;

/** POST /api/planning/baseline/approve — approve a baseline (PLANNING.APPROVE). */
export const approveBaselineSchema = z.object({
  baselineId: z.coerce.number().int().positive(),
});
export type ApproveBaselineDto = z.infer<typeof approveBaselineSchema>;

/** GET list/schedule filters scoped to a project (from the query string). */
export const projectScopeQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export type ProjectScopeQueryDto = z.infer<typeof projectScopeQuerySchema>;
