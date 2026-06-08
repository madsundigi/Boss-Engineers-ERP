import { z } from 'zod';
import { ASSET_TYPE, ASSET_STATUS, WO_TYPE, WO_STATUS } from './maintenance.constants';

const t = (n: number) => z.string().trim().max(n);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = z.coerce.number().int().positive();

// ---------------------------------------------------------------------
// Asset register
// ---------------------------------------------------------------------

/**
 * POST /api/maintenance/assets — register a maintainable asset in ACTIVE. assetCode
 * is unique per company. Tenant / user come from request context.
 */
export const createAssetSchema = z.object({
  assetCode: t(30).min(1, 'An asset code is required'),
  assetName: t(200).min(1, 'An asset name is required'),
  assetType: z.enum(ASSET_TYPE).optional(),
  location: t(60).optional(),
});
export type CreateAssetDto = z.infer<typeof createAssetSchema>;

/** PATCH /api/maintenance/assets/:id — edit an asset. All fields optional except
 *  the optimistic-concurrency rowVersion (asset_code is immutable). */
export const updateAssetSchema = z.object({
  assetName: t(200).min(1).optional(),
  assetType: z.enum(ASSET_TYPE).optional(),
  location: t(60).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateAssetDto = z.infer<typeof updateAssetSchema>;

/** POST /api/maintenance/assets/:id/status — set the asset status directly. */
export const setAssetStatusSchema = z.object({
  status: z.enum(ASSET_STATUS),
  rowVersion: z.coerce.number().int().positive(),
});
export type SetAssetStatusDto = z.infer<typeof setAssetStatusSchema>;

/** GET /api/maintenance/assets — list filters + pagination (from the query string). */
export const assetListQuerySchema = z.object({
  status: z.enum(ASSET_STATUS).optional(),
  type: z.enum(ASSET_TYPE).optional(),
  q: t(60).optional(), // free-text on asset_code / asset_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['asset_code', 'asset_name', 'status', 'created_at']).default('asset_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type AssetListQueryDto = z.infer<typeof assetListQuerySchema>;

// ---------------------------------------------------------------------
// Maintenance work order
// ---------------------------------------------------------------------

/**
 * POST /api/maintenance/work-orders — raise a maintenance work order in OPEN against
 * an asset. mwo_no is allocated by the database (branch-scoped) — it is NOT accepted
 * on the wire. Tenant / branch / user come from request context.
 */
export const createWoSchema = z.object({
  assetId: id,
  woType: z.enum(WO_TYPE),
  scheduledDate: dateStr.optional(),
  notes: t(4000).optional(),
});
export type CreateWoDto = z.infer<typeof createWoSchema>;

/** PATCH /api/maintenance/work-orders/:id — edit a work order (OPEN / IN_PROGRESS). */
export const updateWoSchema = z.object({
  woType: z.enum(WO_TYPE).optional(),
  scheduledDate: dateStr.optional(),
  notes: t(4000).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateWoDto = z.infer<typeof updateWoSchema>;

/** Optimistic-concurrency-only body (start, complete, cancel). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** GET /api/maintenance/work-orders — list filters + pagination (from the query string). */
export const woListQuerySchema = z.object({
  status: z.enum(WO_STATUS).optional(),
  type: z.enum(WO_TYPE).optional(),
  assetId: id.optional(),
  q: t(60).optional(), // free-text on mwo_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['mwo_no', 'scheduled_date', 'status', 'wo_type', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type WoListQueryDto = z.infer<typeof woListQuerySchema>;
