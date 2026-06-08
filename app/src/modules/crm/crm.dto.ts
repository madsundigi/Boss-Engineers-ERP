import { z } from 'zod';
import { OPPORTUNITY_STAGE, ACTIVITY_TYPE, ACTIVITY_STATUS, PIPELINE_ORDER } from './crm.constants';

const t = (n: number) => z.string().trim().max(n);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = z.coerce.number().int().positive();
const money = z.coerce.number().min(0);
const pct = z.coerce.number().min(0).max(100);

/**
 * POST /api/crm/opportunities — raise a sales opportunity in NEW. opp_no is
 * auto-allocated (prefix 'OPP'); stage is NOT accepted on the wire (always NEW).
 * Tenant / branch / user come from request context.
 */
export const createOpportunitySchema = z.object({
  customerId: id,
  enquiryId: id.optional(),
  title: t(200).min(1, 'A title is required'),
  estValue: money.optional(),
  probabilityPct: pct.optional(),
  expectedCloseDate: dateStr.optional(),
  ownerId: id.optional(),
});
export type CreateOpportunityDto = z.infer<typeof createOpportunitySchema>;

/**
 * PATCH /api/crm/opportunities/:id — edit an open opportunity (not WON / LOST). All
 * header fields optional except the optimistic-concurrency rowVersion. Stage is not
 * edited here (use advance / win / lose).
 */
export const updateOpportunitySchema = z.object({
  title: t(200).min(1).optional(),
  estValue: money.optional(),
  probabilityPct: pct.optional(),
  expectedCloseDate: dateStr.optional(),
  ownerId: id.optional(),
  enquiryId: id.optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateOpportunityDto = z.infer<typeof updateOpportunitySchema>;

/** POST /api/crm/opportunities/:id/advance — move forward to the given open stage. */
export const advanceStageSchema = z.object({
  stage: z.enum(PIPELINE_ORDER as [string, ...string[]]),
  rowVersion: z.coerce.number().int().positive(),
});
export type AdvanceStageDto = z.infer<typeof advanceStageSchema>;

/** Optimistic-concurrency-only body (win). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** POST /api/crm/opportunities/:id/lose — mark LOST with a reason. */
export const loseSchema = z.object({
  lostReason: t(300).min(1, 'A reason is required to mark an opportunity lost'),
  rowVersion: z.coerce.number().int().positive(),
});
export type LoseDto = z.infer<typeof loseSchema>;

/** GET /api/crm/opportunities — list filters + pagination (all from the query string). */
export const listOpportunityQuerySchema = z.object({
  stage: z.enum(OPPORTUNITY_STAGE).optional(),
  customerId: id.optional(),
  ownerId: id.optional(),
  q: t(60).optional(), // free-text on opp_no / title
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['opp_no', 'stage', 'est_value', 'expected_close_date', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListOpportunityQueryDto = z.infer<typeof listOpportunityQuerySchema>;

/**
 * POST /api/crm/activities — log a follow-up activity, linked to an opportunity
 * and/or a customer (at least one is required — enforced in the service). Raised
 * PENDING. Tenant / user come from request context.
 */
export const createActivitySchema = z.object({
  oppId: id.optional(),
  customerId: id.optional(),
  activityType: z.enum(ACTIVITY_TYPE),
  subject: t(200).min(1, 'A subject is required'),
  dueDate: dateStr.optional(),
  ownerId: id.optional(),
  notes: t(4000).optional(),
});
export type CreateActivityDto = z.infer<typeof createActivitySchema>;

/** GET /api/crm/activities — list filters + pagination (all from the query string). */
export const listActivityQuerySchema = z.object({
  oppId: id.optional(),
  customerId: id.optional(),
  status: z.enum(ACTIVITY_STATUS).optional(),
  activityType: z.enum(ACTIVITY_TYPE).optional(),
  overdue: z.coerce.boolean().optional(), // PENDING with due_date < today
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['due_date', 'status', 'activity_type', 'created_at']).default('due_date'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListActivityQueryDto = z.infer<typeof listActivityQuerySchema>;
