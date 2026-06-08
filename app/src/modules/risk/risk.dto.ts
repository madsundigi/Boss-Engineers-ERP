import { z } from 'zod';
import { RISK_STATUS, RISK_CATEGORY, SCORE_MIN, SCORE_MAX } from './risk.constants';

const t = (n: number) => z.string().trim().max(n);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = z.coerce.number().int().positive();
/** Likelihood / impact ordinal: integer in the 1..5 matrix bounds. */
const score = z.coerce.number().int().min(SCORE_MIN).max(SCORE_MAX);

/**
 * POST /api/risks — raise a project risk in OPEN. severity is NOT accepted on the
 * wire: it is the database-computed product likelihood * impact. Tenant / branch /
 * user come from request context.
 */
export const createRiskSchema = z.object({
  projectId: id,
  title: t(200).min(1, 'A risk title is required'),
  description: t(4000).optional(),
  category: z.enum(RISK_CATEGORY).optional(),
  likelihood: score,
  impact: score,
  mitigation: t(4000).optional(),
  ownerId: id.optional(),
  dueDate: dateStr.optional(),
});
export type CreateRiskDto = z.infer<typeof createRiskSchema>;

/** PATCH /api/risks/:id — edit a risk (not CLOSED / ACCEPTED). All fields optional
 *  except the optimistic-concurrency rowVersion. */
export const updateRiskSchema = z.object({
  title: t(200).min(1).optional(),
  description: t(4000).optional(),
  category: z.enum(RISK_CATEGORY).optional(),
  likelihood: score.optional(),
  impact: score.optional(),
  mitigation: t(4000).optional(),
  ownerId: id.optional(),
  dueDate: dateStr.optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateRiskDto = z.infer<typeof updateRiskSchema>;

/** Optimistic-concurrency-only body (startMitigation, close, accept). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** GET /api/risks — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(RISK_STATUS).optional(),
  category: z.enum(RISK_CATEGORY).optional(),
  projectId: id.optional(),
  q: t(60).optional(), // free-text on title
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['severity', 'likelihood', 'impact', 'status', 'due_date', 'created_at']).default('severity'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
