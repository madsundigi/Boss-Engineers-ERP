import { z } from 'zod';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();
/** Money / quantity: numeric(20,4). Prices/levels are non-negative. */
const money = z.coerce.number().min(0);

/**
 * POST /api/spares — add a spare part to the catalog. part_code is user-supplied and
 * unique per company (the DB enforces uq_spare_part_code; the service maps the 23505
 * to a 409). Tenant / user come from request context — never the body.
 */
export const createPartSchema = z.object({
  partCode: t(30).min(1, 'A part code is required'),
  partName: t(200).min(1, 'A part name is required'),
  uom: t(10).optional(),
  itemId: id.optional(),
  unitPrice: money.optional(),
  reorderLevel: money.optional(),
  isActive: z.coerce.boolean().optional(),
});
export type CreatePartDto = z.infer<typeof createPartSchema>;

/** PATCH /api/spares/:id — edit a spare part. part_code is immutable (the stable
 *  business key). All fields optional except the optimistic-concurrency rowVersion. */
export const updatePartSchema = z.object({
  partName: t(200).min(1).optional(),
  uom: t(10).optional(),
  itemId: id.optional(),
  unitPrice: money.optional(),
  reorderLevel: money.optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdatePartDto = z.infer<typeof updatePartSchema>;

/** PATCH /api/spares/:id/active — flip is_active under optimistic concurrency. */
export const setActiveSchema = z.object({
  isActive: z.coerce.boolean(),
  rowVersion: z.coerce.number().int().positive(),
});
export type SetActiveDto = z.infer<typeof setActiveSchema>;

/** Optimistic-concurrency-only body (soft delete via the query string). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/**
 * POST /api/spares/:id/stock — adjust on-hand at a location by a signed delta. The
 * service upserts svc.spare_stock and adds the delta; a move that would drive the
 * balance negative is rejected (400). delta must be a non-zero number.
 */
export const adjustStockSchema = z.object({
  location: t(40).min(1).optional(),
  delta: z.coerce.number().refine((n) => n !== 0, 'delta must be non-zero'),
});
export type AdjustStockDto = z.infer<typeof adjustStockSchema>;

/** GET /api/spares — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  q: t(60).optional(), // free-text on part_code + part_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['part_code', 'part_name', 'unit_price', 'created_at']).default('part_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
