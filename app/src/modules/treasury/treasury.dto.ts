import { z } from 'zod';
import { CASHFLOW_DIRECTION, CASHFLOW_CATEGORY } from './treasury.constants';

const t = (n: number) => z.string().trim().max(n);
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = z.coerce.number().int().positive();
/** A period bucket label, e.g. '2026-07' (free-form, max 10 chars). */
const period = t(10).min(1, 'A period label is required');

/**
 * POST /api/treasury/forecasts — append a cash-flow forecast entry. direction +
 * periodLabel + amount are required; forecastDate defaults to today; category,
 * projectId, note are optional. Tenant / branch / user come from request context.
 */
export const createForecastSchema = z.object({
  forecastDate: isoDate.optional(),
  periodLabel: period,
  direction: z.enum(CASHFLOW_DIRECTION),
  category: z.enum(CASHFLOW_CATEGORY).optional(),
  amount: z.coerce.number().positive('Amount must be positive'),
  projectId: id.optional(),
  note: t(300).optional(),
});
export type CreateForecastDto = z.infer<typeof createForecastSchema>;

/** GET /api/treasury/forecasts — list filters + pagination (from the query string). */
export const listQuerySchema = z.object({
  direction: z.enum(CASHFLOW_DIRECTION).optional(),
  periodLabel: t(10).optional(),
  projectId: id.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;

/** GET /api/treasury/forecasts/summary — net cash by period, optional project filter. */
export const summaryQuerySchema = z.object({
  projectId: id.optional(),
});
export type SummaryQueryDto = z.infer<typeof summaryQuerySchema>;
