import { z } from 'zod';

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/**
 * POST /api/profitability/compute — compute & record a margin snapshot for a
 * project. projectId is the only input; revenue and costs are aggregated from the
 * cost ledger + invoices, and snapshot_date defaults to today. The snapshot is
 * append-only (re-computing inserts a fresh row).
 */
export const computeSnapshotSchema = z.object({
  projectId: z.coerce.number().int().positive(),
});
export type ComputeSnapshotDto = z.infer<typeof computeSnapshotSchema>;

/** GET /api/profitability — list filters + pagination (from the query string). */
export const listQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
