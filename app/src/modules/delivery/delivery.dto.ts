import { z } from 'zod';
import { RISK_LEVEL, DRIVER } from './delivery.constants';

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/**
 * POST /api/delivery-forecasts — record a new forecast snapshot for a project.
 * projectId + predictedDelivery are required; committedDelivery, riskLevel, driver
 * are optional; forecastDate defaults to today. delay_days is computed by the DB
 * (generated column) and is never accepted from the client. created_by = context.
 */
export const createForecastSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  forecastDate: isoDate.optional(),
  predictedDelivery: isoDate,
  committedDelivery: isoDate.optional(),
  riskLevel: z.enum(RISK_LEVEL).optional(),
  driver: z.enum(DRIVER).optional(),
});
export type CreateForecastDto = z.infer<typeof createForecastSchema>;

/** GET /api/delivery-forecasts — list filters + pagination (from the query string). */
export const listQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  riskLevel: z.enum(RISK_LEVEL).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
