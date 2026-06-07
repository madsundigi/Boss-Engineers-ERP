import { z } from 'zod';
import { ACCOUNT_TYPE, COST_TYPE, COST_STAGE } from './gl.constants';

const t = (n: number) => z.string().trim().max(n);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const money = z.coerce.number().min(0);

/** POST /api/gl/accounts — create a chart-of-accounts entry (gl_code unique per company). */
export const createAccountSchema = z.object({
  glCode: t(20).min(1, 'A GL code is required'),
  glName: t(120).min(1, 'A GL name is required'),
  accountType: z.enum(ACCOUNT_TYPE),
  isActive: z.boolean().optional(),
});
export type CreateAccountDto = z.infer<typeof createAccountSchema>;

/** PATCH /api/gl/accounts/:id/active — flip is_active (no row_version; master is simple). */
export const setActiveSchema = z.object({ isActive: z.boolean() });
export type SetActiveDto = z.infer<typeof setActiveSchema>;

/** GET /api/gl/accounts — list filters. */
export const accountQuerySchema = z.object({
  accountType: z.enum(ACCOUNT_TYPE).optional(),
  isActive: z.coerce.boolean().optional(),
});
export type AccountQueryDto = z.infer<typeof accountQuerySchema>;

/**
 * One journal line. Exactly ONE of debit/credit must be > 0 (enforced in the
 * service's double-entry invariant — zod only checks shape/non-negativity here).
 */
const journalLineSchema = z.object({
  glId: z.coerce.number().int().positive(),
  debit: money.optional(),
  credit: money.optional(),
  costCenterId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
});

/**
 * POST /api/gl/journals — post an immutable, balanced journal. postingDate
 * defaults to CURRENT_DATE (the partition key); pass one only within an existing
 * monthly partition. >= 2 lines; totals must balance (service-enforced).
 */
export const postJournalSchema = z.object({
  postingDate: dateStr.optional(),
  narration: t(300).optional(),
  sourceDocType: t(20).optional(),
  sourceDocId: z.coerce.number().int().positive().optional(),
  lines: z.array(journalLineSchema).min(2, 'A journal needs at least two lines').max(500),
});
export type PostJournalDto = z.infer<typeof postJournalSchema>;

/** GET /api/gl/journals — list filters + pagination. */
export const journalQuerySchema = z.object({
  sourceDocType: t(20).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  fromDate: dateStr.optional(),
  toDate: dateStr.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type JournalQueryDto = z.infer<typeof journalQuerySchema>;

/** GET /api/gl/trial-balance — totals as-of a cut-off date (inclusive). */
export const trialBalanceQuerySchema = z.object({ asOfDate: dateStr.optional() });
export type TrialBalanceQueryDto = z.infer<typeof trialBalanceQuerySchema>;

/** GET /api/gl/accounts/:id/ledger — one account's lines within a date range. */
export const ledgerQuerySchema = z.object({
  fromDate: dateStr.optional(),
  toDate: dateStr.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type LedgerQueryDto = z.infer<typeof ledgerQuerySchema>;

/** POST /api/gl/costs — append a project-cost-ledger row (immutable). */
export const postCostSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  wbsId: z.coerce.number().int().positive().optional(),
  costType: z.enum(COST_TYPE),
  costStage: z.enum(COST_STAGE),
  amount: z.coerce.number(), // sign allowed (a reversal/credit can be negative)
  refDocType: t(20).min(1, 'A reference document type is required'),
  refDocId: z.coerce.number().int().positive(),
  postingDate: dateStr.optional(),
});
export type PostCostDto = z.infer<typeof postCostSchema>;
