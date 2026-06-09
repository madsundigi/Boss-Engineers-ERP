import { z } from 'zod';
import { FAT_RESULT, FAT_STATUS, PUNCH_SEVERITY, RESULT_PF } from './fat.constants';

const t = (n: number) => z.string().trim().max(n);

/** POST /api/fat — schedule a new FAT (tenant/user come from context). */
export const createFatSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  protocolId: z.coerce.number().int().positive(),
  woId: z.coerce.number().int().positive().optional(),
  fatDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  customerWitness: t(120).optional(),
  engineerId: z.coerce.number().int().positive().optional(),
  // status is server-defaulted to SCHEDULED; result is set later via /result.
});
export type CreateFatDto = z.infer<typeof createFatSchema>;

/** PATCH /api/fat/:id — edit header fields (only while not yet cleared). */
export const updateFatSchema = z.object({
  woId: z.coerce.number().int().positive().optional(),
  fatDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  customerWitness: t(120).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateFatDto = z.infer<typeof updateFatSchema>;

const resultLineSchema = z.object({
  paramId: z.coerce.number().int().positive(),
  measuredValue: z.coerce.number().optional(),
  passFail: z.enum(RESULT_PF),
});

const punchItemSchema = z.object({
  description: t(400).min(1, 'Punch item description is required'),
  severity: z.enum(PUNCH_SEVERITY).optional(),
});

/**
 * POST /api/fat/:id/result — record the test execution outcome.
 * On FAIL/CONDITIONAL a punch list of defects is required; the FAT moves to
 * IN_PROGRESS -> PASSED|FAILED. Param result lines are optional measurements.
 */
export const recordResultSchema = z.object({
  result: z.enum(FAT_RESULT),
  lines: z.array(resultLineSchema).max(500).optional(),
  punchItems: z.array(punchItemSchema).max(200).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type RecordResultDto = z.infer<typeof recordResultSchema>;

/** POST /api/fat/:id/status — guarded lifecycle transition. */
export const changeStatusSchema = z.object({
  status: z.enum(FAT_STATUS),
  rowVersion: z.coerce.number().int().positive(),
});
export type ChangeStatusDto = z.infer<typeof changeStatusSchema>;

/** POST /api/fat/:id/approve — customer/QC sign-off (yields the Dispatch-clearance state). */
export const approveSchema = z.object({
  customerWitness: t(120).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type ApproveDto = z.infer<typeof approveSchema>;

/** GET /api/fat — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(FAT_STATUS).optional(),
  result: z.enum(FAT_RESULT).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  q: t(60).optional(), // free-text on fat_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['fat_no', 'fat_date', 'status', 'result', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
