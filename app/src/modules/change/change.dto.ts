import { z } from 'zod';
import { CHANGE_STATUS } from './change.constants';

const t = (n: number) => z.string().trim().max(n);

/**
 * POST /api/change-orders — raise a project-pegged change order in DRAFT.
 * costImpact / priceImpact may be negative (a de-scope reduces cost & revenue);
 * scheduleImpactDays may be negative (an acceleration). Tenant/user come from
 * context; the change number is allocated server-side.
 */
export const createChangeOrderSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  description: t(2000).min(1, 'A description is required'),
  reason: t(2000).optional(),
  costImpact: z.coerce.number().default(0),
  priceImpact: z.coerce.number().default(0),
  scheduleImpactDays: z.coerce.number().int().default(0),
});
export type CreateChangeOrderDto = z.infer<typeof createChangeOrderSchema>;

/** PATCH /api/change-orders/:id — amend header fields (DRAFT only). */
export const updateChangeOrderSchema = z.object({
  description: t(2000).min(1).optional(),
  reason: t(2000).optional(),
  costImpact: z.coerce.number().optional(),
  priceImpact: z.coerce.number().optional(),
  scheduleImpactDays: z.coerce.number().int().optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateChangeOrderDto = z.infer<typeof updateChangeOrderSchema>;

/** Optimistic-concurrency-only body (submit, approve, markImplemented). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** POST /api/change-orders/:id/reject — reject a SUBMITTED variation with a reason. */
export const rejectSchema = z.object({
  reason: t(2000).min(1, 'A reason is required to reject'),
  rowVersion: z.coerce.number().int().positive(),
});
export type RejectDto = z.infer<typeof rejectSchema>;

/** GET /api/change-orders — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(CHANGE_STATUS).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  q: t(60).optional(), // free-text on co_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['co_no', 'status', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
