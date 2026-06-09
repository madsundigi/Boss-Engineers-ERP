import { z } from 'zod';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();

/**
 * POST /api/warehouses — create an inventory location under a business unit. buId,
 * whCode and whName are required; the bu must belong to the caller's company (the
 * service rejects a foreign bu with a 404). wh_code is unique within the bu (the DB
 * enforces uq_wh; a duplicate maps to a 409). Tenant / user come from request context.
 */
export const createWarehouseSchema = z.object({
  buId: id,
  whCode: t(15).min(1, 'A warehouse code is required'),
  whName: t(100).min(1, 'A warehouse name is required'),
  isActive: z.coerce.boolean().optional(),
});
export type CreateWarehouseDto = z.infer<typeof createWarehouseSchema>;

/** PATCH /api/warehouses/:id — edit a warehouse. wh_code and bu_id are immutable (the
 *  stable identity). No rowVersion: mdm.warehouse has no row_version column, so there
 *  is no optimistic concurrency. At least one field must be supplied. */
export const updateWarehouseSchema = z.object({
  whName: t(100).min(1).optional(),
  isActive: z.coerce.boolean().optional(),
});
export type UpdateWarehouseDto = z.infer<typeof updateWarehouseSchema>;

/** GET /api/warehouses — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  buId: id.optional(), // optional business-unit filter
  q: t(60).optional(), // free-text on wh_code + wh_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['wh_code', 'wh_name']).default('wh_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
