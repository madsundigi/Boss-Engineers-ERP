import { z } from 'zod';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();
/** capacity_per_day numeric(20,4) / cost_rate numeric(20,6); non-negative. */
const nonNeg = z.coerce.number().min(0);

/**
 * POST /api/work-centers — create a work centre. wc_code is user-supplied and globally
 * UNIQUE (the DB enforces it; the service maps the 23505 to a 409). buId is required and
 * must belong to the caller's company (the service verifies this). The table has no
 * company_id, so the tenant gate is the parent business unit.
 */
export const createWorkCenterSchema = z.object({
  buId: id,
  wcCode: t(20).min(1, 'A work-centre code is required'),
  wcName: t(80).min(1, 'A work-centre name is required'),
  capacityPerDay: nonNeg.optional(),
  costRate: nonNeg.optional(),
  isActive: z.coerce.boolean().optional(),
});
export type CreateWorkCenterDto = z.infer<typeof createWorkCenterSchema>;

/** PATCH /api/work-centers/:id — edit a work centre. wc_code is immutable (the stable
 *  business key). The table has no row_version, so there is no optimistic concurrency.
 *  buId may be moved, but only to another BU in the caller's company (service-checked). */
export const updateWorkCenterSchema = z.object({
  buId: id.optional(),
  wcName: t(80).min(1).optional(),
  capacityPerDay: nonNeg.optional(),
  costRate: nonNeg.optional(),
  isActive: z.coerce.boolean().optional(),
});
export type UpdateWorkCenterDto = z.infer<typeof updateWorkCenterSchema>;

/** GET /api/work-centers — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  buId: id.optional(), // narrow to one business unit (still within the caller's company)
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  q: t(60).optional(), // free-text on wc_code + wc_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['wc_code', 'wc_name']).default('wc_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
