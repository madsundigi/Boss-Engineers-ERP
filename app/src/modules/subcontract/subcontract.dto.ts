import { z } from 'zod';
import { SUBCONTRACT_STATUS } from './subcontract.constants';

const t = (n: number) => z.string().trim().max(n);

/** A line of material/processed goods: an item and a positive qty. */
const lineSchema = z.object({
  itemId: z.coerce.number().int().positive(),
  qty: z.coerce.number().positive(),
});

/**
 * POST /api/subcontracts — open a job-work order against a vendor in OPEN.
 * `items` are the components intended for processing (issued later). projectId is
 * the optional project peg. Tenant/branch/user come from the request context.
 */
export const createSubcontractSchema = z.object({
  vendorId: z.coerce.number().int().positive(),
  projectId: z.coerce.number().int().positive().optional(),
  scoDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  items: z.array(lineSchema).max(500).optional(),
});
export type CreateSubcontractDto = z.infer<typeof createSubcontractSchema>;

/** PATCH /api/subcontracts/:id — edit header / planned items (OPEN only). */
export const updateSubcontractSchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  scoDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  items: z.array(lineSchema).max(500).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateSubcontractDto = z.infer<typeof updateSubcontractSchema>;

/**
 * POST /api/subcontracts/:id/issue — send material to the vendor (OPEN -> ISSUED).
 * If `items` is omitted the order's planned items are issued as-is.
 */
export const issueSchema = z.object({
  items: z.array(lineSchema).max(500).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type IssueDto = z.infer<typeof issueSchema>;

/**
 * POST /api/subcontracts/:id/receive — take processed goods back (ISSUED ->
 * RECEIVED). If `items` is omitted the issued quantities are received as-is.
 */
export const receiveSchema = z.object({
  items: z.array(lineSchema).max(500).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type ReceiveDto = z.infer<typeof receiveSchema>;

/** Optimistic-concurrency-only body (close). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** POST /api/subcontracts/:id/cancel — abandon an order with a reason. */
export const cancelSchema = z.object({
  reason: t(300).min(1, 'A reason is required to cancel'),
  rowVersion: z.coerce.number().int().positive(),
});
export type CancelDto = z.infer<typeof cancelSchema>;

/** GET /api/subcontracts — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(SUBCONTRACT_STATUS).optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  q: t(60).optional(), // free-text on sco_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['sco_no', 'sco_date', 'status', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
