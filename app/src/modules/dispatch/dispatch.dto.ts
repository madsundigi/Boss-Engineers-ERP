import { z } from 'zod';
import { DISPATCH_STATUS } from './dispatch.constants';

const t = (n: number) => z.string().trim().max(n);

/** A shipment serial line: an item, an optional captured serial, and a qty. */
const serialSchema = z.object({
  itemId: z.coerce.number().int().positive(),
  serialId: z.coerce.number().int().positive().optional(),
  qty: z.coerce.number().positive(),
});

/** A package on the packing list. */
const packingLineSchema = z.object({
  packageNo: t(30).min(1, 'A package number is required'),
  grossWeight: z.coerce.number().min(0).optional(),
  dimensions: t(60).optional(),
});

/**
 * POST /api/dispatch — create a project-pegged dispatch in DRAFT.
 * customerId is the ship-to party; serials capture as-built/warranty linkage;
 * the packing list is optional at create. Tenant/user come from context.
 */
export const createDispatchSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  customerId: z.coerce.number().int().positive(),
  fatId: z.coerce.number().int().positive().optional(),
  shipToAddressId: z.coerce.number().int().positive().optional(),
  dispatchDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  transporter: t(120).optional(),
  lrNo: t(40).optional(),
  ewayBillNo: t(20).optional(),
  serials: z.array(serialSchema).max(500).optional(),
  packingLines: z.array(packingLineSchema).max(200).optional(),
});
export type CreateDispatchDto = z.infer<typeof createDispatchSchema>;

/** PATCH /api/dispatch/:id — edit header / commercial fields (DRAFT only). */
export const updateDispatchSchema = z.object({
  shipToAddressId: z.coerce.number().int().positive().optional(),
  dispatchDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  transporter: t(120).optional(),
  lrNo: t(40).optional(),
  ewayBillNo: t(20).optional(),
  serials: z.array(serialSchema).max(500).optional(),
  packingLines: z.array(packingLineSchema).max(200).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateDispatchDto = z.infer<typeof updateDispatchSchema>;

/** POST /api/dispatch/:id/clear-quality | /clear-commercial — open one gate. */
export const clearSchema = z.object({
  note: t(300).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type ClearDto = z.infer<typeof clearSchema>;

/** Optimistic-concurrency-only body (release, deliver). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** POST /api/dispatch/:id/cancel — abandon a dispatch with a reason. */
export const cancelSchema = z.object({
  reason: t(300).min(1, 'A reason is required to cancel'),
  rowVersion: z.coerce.number().int().positive(),
});
export type CancelDto = z.infer<typeof cancelSchema>;

/** GET /api/dispatch — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(DISPATCH_STATUS).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  q: t(60).optional(), // free-text on dispatch_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['dispatch_no', 'dispatch_date', 'status', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
