import { z } from 'zod';
import { ITEM_TYPES } from './items.constants';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();
/** reorder_level is numeric(20,4); a level is non-negative. */
const qty = z.coerce.number().min(0);

/**
 * POST /api/items — add an item to the catalog. item_code is user-supplied and
 * required; the DB enforces uniqueness (the service maps the 23505 to a 409).
 * Tenant / user come from request context — never the body.
 */
export const createItemSchema = z.object({
  itemCode: t(30).min(1, 'An item code is required'),
  itemName: t(200).min(1, 'An item name is required'),
  categoryId: id,
  type: z.enum(ITEM_TYPES),
  baseUomId: id,
  hsnSacId: id.optional(),
  reorderLevel: qty.optional(),
  isCritical: z.coerce.boolean().optional(),
});
export type CreateItemDto = z.infer<typeof createItemSchema>;

/**
 * PATCH /api/items/:id — edit an item. item_code is immutable (the stable business
 * key). All fields optional except the optimistic-concurrency rowVersion.
 */
export const updateItemSchema = z.object({
  itemName: t(200).min(1).optional(),
  categoryId: id.optional(),
  type: z.enum(ITEM_TYPES).optional(),
  baseUomId: id.optional(),
  hsnSacId: id.optional(),
  reorderLevel: qty.optional(),
  isCritical: z.coerce.boolean().optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateItemDto = z.infer<typeof updateItemSchema>;

/** Optimistic-concurrency-only body (soft delete via the query string). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** GET /api/items — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  q: t(60).optional(), // free-text on item_code + item_name
  type: z.enum(ITEM_TYPES).optional(),
  categoryId: id.optional(),
  critical: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['item_code', 'item_name', 'item_type', 'created_at']).default('item_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
