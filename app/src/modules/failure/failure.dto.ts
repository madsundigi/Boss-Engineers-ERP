import { z } from 'zod';
import { NCR_STATUS, NCR_SOURCE, RCA_METHOD, CAPA_TYPE, CAPA_STATUS } from './failure.constants';

const t = (n: number) => z.string().trim().max(n);
const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/**
 * POST /api/ncrs — raise a nonconformance in OPEN.
 * source is required + validated (where the failure was found); the rest pegs the
 * failed item / project / failure-mode. Tenant/user come from context — never the body.
 */
export const createNcrSchema = z.object({
  source: z.enum(NCR_SOURCE),
  sourceDocId: z.coerce.number().int().positive().optional(),
  itemId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  failureModeId: z.coerce.number().int().positive().optional(),
  severity: t(10).optional(),
  raisedDate: date.optional(),
  costImpact: z.coerce.number().nonnegative().optional(), // quantified cost of the nonconformance
});
export type CreateNcrDto = z.infer<typeof createNcrSchema>;

/** POST /api/ncrs/:id/rca — record a root-cause analysis (advances OPEN -> RCA). */
export const addRcaSchema = z.object({
  method: z.enum(RCA_METHOD),
  rootCause: t(8000).optional(),
  analysis: z.record(z.unknown()).optional(), // free-form 5WHY / fishbone tree
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency on the NCR
});
export type AddRcaDto = z.infer<typeof addRcaSchema>;

/** POST /api/ncrs/:id/capa — record a corrective/preventive action (advances -> CAPA). */
export const addCapaSchema = z.object({
  capaType: z.enum(CAPA_TYPE),
  action: t(8000).min(1, 'An action is required'),
  ownerId: z.coerce.number().int().positive().optional(),
  dueDate: date.optional(),
  effectivenessCheck: t(300).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type AddCapaDto = z.infer<typeof addCapaSchema>;

/** POST /api/ncrs/:id/capa/:capaId/actions — add a step under a CAPA. */
export const addCapaActionSchema = z.object({
  description: t(400).min(1, 'A description is required'),
  ownerId: z.coerce.number().int().positive().optional(),
  dueDate: date.optional(),
});
export type AddCapaActionDto = z.infer<typeof addCapaActionSchema>;

/** PATCH /api/ncrs/:id/capa/:capaId — advance a CAPA's status (e.g. -> VERIFIED). */
export const updateCapaStatusSchema = z.object({
  status: z.enum(CAPA_STATUS),
  effectivenessCheck: t(300).optional(),
});
export type UpdateCapaStatusDto = z.infer<typeof updateCapaStatusSchema>;

/** Optimistic-concurrency-only body (close the NCR). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/**
 * GET /api/ncrs/pareto — Pareto / repeat-failure report (read-only aggregation).
 * `by` chooses the dimension to bucket NCRs on (failure mode by default, or severity
 * / source); the optional raised_date window narrows the population. No paging — a
 * Pareto is the full ordered distribution. `toDate` must not precede `fromDate`.
 */
export const paretoQuerySchema = z
  .object({
    by: z.enum(['mode', 'severity', 'source']).default('mode'),
    fromDate: date.optional(),
    toDate: date.optional(),
  })
  .refine((q) => !(q.fromDate && q.toDate) || q.fromDate <= q.toDate, {
    message: '`fromDate` must be on or before `toDate`',
    path: ['toDate'],
  });
export type ParetoQueryDto = z.infer<typeof paretoQuerySchema>;

/** GET /api/ncrs — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(NCR_STATUS).optional(),
  source: z.enum(NCR_SOURCE).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  q: t(60).optional(), // free-text on ncr_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['ncr_no', 'raised_date', 'status', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
