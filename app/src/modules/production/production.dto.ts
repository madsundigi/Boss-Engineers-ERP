import { z } from 'zod';
import { WO_STATUS } from './production.constants';

const t = (n: number) => z.string().trim().max(n);
const ymd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const qty = z.coerce.number().nonnegative();

/** A routing operation supplied on create / edit. */
const operationSchema = z.object({
  opSeq: z.coerce.number().int().positive(),
  workCenterId: z.coerce.number().int().positive(),
  stdTimeMin: z.coerce.number().nonnegative().optional().default(0),
});

/** A material requirement line supplied on create / edit. */
const materialSchema = z.object({
  itemId: z.coerce.number().int().positive(),
  requiredQty: z.coerce.number().positive(),
});

/**
 * POST /api/work-orders — raise a project-pegged work order (tenant/user from
 * context). Operations / material are optional; the WO number is server-allocated.
 */
export const createWorkOrderSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
  qty: z.coerce.number().positive(),
  wbsId: z.coerce.number().int().positive().optional(),
  bomId: z.coerce.number().int().positive().optional(),
  routingId: z.coerce.number().int().positive().optional(),
  plannedStart: ymd.optional(),
  plannedEnd: ymd.optional(),
  operations: z.array(operationSchema).max(200).optional(),
  materials: z.array(materialSchema).max(500).optional(),
  // status is server-defaulted to PLANNED on create; not accepted from the client.
});
export type CreateWorkOrderDto = z.infer<typeof createWorkOrderSchema>;

/** PATCH /api/work-orders/:id — edit the plan (only while PLANNED). */
export const updateWorkOrderSchema = z.object({
  qty: z.coerce.number().positive().optional(),
  wbsId: z.coerce.number().int().positive().optional(),
  bomId: z.coerce.number().int().positive().optional(),
  routingId: z.coerce.number().int().positive().optional(),
  plannedStart: ymd.optional(),
  plannedEnd: ymd.optional(),
  operations: z.array(operationSchema).max(200).optional(),
  materials: z.array(materialSchema).max(500).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateWorkOrderDto = z.infer<typeof updateWorkOrderSchema>;

/**
 * POST /api/work-orders/:id/release — release to the shop floor (WORK_ORDER.APPROVE).
 * Blocked (409) unless material is ready (`materialReady` true).
 */
export const releaseSchema = z.object({
  materialReady: z.coerce.boolean(),
  plannedStart: ymd.optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type ReleaseDto = z.infer<typeof releaseSchema>;

/**
 * POST /api/work-orders/:id/confirm — record production against an operation.
 * Produced / scrap / rework quantities + the actual labour hours expended.
 */
export const confirmSchema = z.object({
  woOpId: z.coerce.number().int().positive(),
  producedQty: qty,
  scrapQty: qty.optional().default(0),
  reworkQty: qty.optional().default(0),
  actualHours: z.coerce.number().nonnegative().optional().default(0),
  confDate: ymd.optional(),
  operationDone: z.coerce.boolean().optional().default(false),
});
export type ConfirmDto = z.infer<typeof confirmSchema>;

/** An as-built serial recorded at completion. */
const asBuiltSchema = z.object({
  serialNo: t(60).min(1, 'Serial number is required'),
  parentSerialNo: t(60).optional(),
});

/**
 * POST /api/work-orders/:id/complete — finish the WO with its as-built serials.
 * Each serial is registered against the WO's item + project (genealogy optional).
 */
export const completeSchema = z.object({
  asBuilt: z.array(asBuiltSchema).max(500).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type CompleteDto = z.infer<typeof completeSchema>;

/** POST /api/work-orders/:id/status — guarded lifecycle transition (hold/cancel/resume). */
export const changeStatusSchema = z.object({
  status: z.enum(WO_STATUS),
  reason: t(300).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type ChangeStatusDto = z.infer<typeof changeStatusSchema>;

/** GET /api/work-orders — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(WO_STATUS).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  itemId: z.coerce.number().int().positive().optional(),
  q: t(60).optional(), // free-text on wo_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['wo_no', 'status', 'qty', 'planned_start', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
