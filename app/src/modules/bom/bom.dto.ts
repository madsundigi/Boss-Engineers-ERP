import { z } from 'zod';
import { BOM_STATUS, BOM_TYPE } from './bom.constants';

const t = (n: number) => z.string().trim().max(n);

/** A component line: an item, a per-assembly qty in a UoM, optional scrap %. */
const lineSchema = z.object({
  componentItemId: z.coerce.number().int().positive(),
  qtyPer: z.coerce.number().positive(), // qty_per > 0 (base CHECK)
  uomId: z.coerce.number().int().positive(),
  scrapPct: z.coerce.number().min(0).max(100).optional(),
  isCritical: z.coerce.boolean().optional(),
});

/**
 * POST /api/boms — create a BOM in DRAFT for a parent item.
 * The document number is allocated server-side; tenant/branch/user come from
 * context. Lines are optional at create (a BOM may be drafted then filled in).
 */
export const createBomSchema = z.object({
  parentItemId: z.coerce.number().int().positive(),
  bomType: z.enum(BOM_TYPE),
  revision: t(10).min(1, 'A revision is required'),
  projectId: z.coerce.number().int().positive().optional(),
  effectiveFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  lines: z.array(lineSchema).max(1000).optional(),
});
export type CreateBomDto = z.infer<typeof createBomSchema>;

/** PATCH /api/boms/:id — edit header + replace lines (DRAFT only). */
export const updateBomSchema = z.object({
  bomType: z.enum(BOM_TYPE).optional(),
  revision: t(10).min(1).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  effectiveFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(lineSchema).max(1000).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateBomDto = z.infer<typeof updateBomSchema>;

/** Optimistic-concurrency-only body (release, obsolete). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** GET /api/boms — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(BOM_STATUS).optional(),
  bomType: z.enum(BOM_TYPE).optional(),
  parentItemId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  q: t(60).optional(), // free-text on bom_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['bom_no', 'revision', 'status', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
