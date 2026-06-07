import { z } from 'zod';
import { HEALTH_RAG, PROJECT_STATUS } from './project.constants';

const trimmed = (max: number) => z.string().trim().max(max);
const ymd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** POST /projects — the business fields (tenant/user come from context). */
export const createProjectSchema = z.object({
  projectName: trimmed(200).min(1, 'Project Name is required'),
  customerId: z.coerce.number().int().positive(),
  pmUserId: z.coerce.number().int().positive(),
  contractValue: z.coerce.number().min(0).optional().default(0),
  budgetCost: z.coerce.number().min(0).optional().default(0),
  quotationId: z.coerce.number().int().positive().optional(),
  plannedStart: ymd.optional(),
  plannedEnd: ymd.optional(),
  contractualEnd: ymd.optional(),
  ldPctPerWeek: z.coerce.number().min(0).optional(),
  // status is server-defaulted to PLANNING on create; not accepted from the client
});
export type CreateProjectDto = z.infer<typeof createProjectSchema>;

/** PATCH /projects/:id — all editable fields optional (partial update). */
export const updateProjectSchema = z.object({
  projectName: trimmed(200).min(1).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  pmUserId: z.coerce.number().int().positive().optional(),
  contractValue: z.coerce.number().min(0).optional(),
  budgetCost: z.coerce.number().min(0).optional(),
  quotationId: z.coerce.number().int().positive().optional(),
  plannedStart: ymd.optional(),
  plannedEnd: ymd.optional(),
  contractualEnd: ymd.optional(),
  ldPctPerWeek: z.coerce.number().min(0).optional(),
  healthRag: z.enum(HEALTH_RAG).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateProjectDto = z.infer<typeof updateProjectSchema>;

/** POST /projects/:id/status — guarded transition. */
export const changeStatusSchema = z.object({
  status: z.enum(PROJECT_STATUS),
  reason: trimmed(300).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type ChangeStatusDto = z.infer<typeof changeStatusSchema>;

/** POST /projects/:id/approve — charter / budget baseline sign-off (FINANCE/CEO). */
export const approveSchema = z.object({
  rowVersion: z.coerce.number().int().positive(),
});
export type ApproveDto = z.infer<typeof approveSchema>;

/** GET /projects — list filters + pagination (all from query string). */
export const listQuerySchema = z.object({
  status: z.enum(PROJECT_STATUS).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(), // free-text on project_no / project_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['project_no', 'project_name', 'status', 'contract_value', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
