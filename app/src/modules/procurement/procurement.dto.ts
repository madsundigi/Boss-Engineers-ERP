import { z } from 'zod';
import { PR_STATUS, PO_STATUS, GRN_STATUS } from './procurement.constants';

const date = () => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = () => z.coerce.number().int().positive();
const optId = () => z.coerce.number().int().positive().optional();

// ---- Purchase Requisition --------------------------------------------------

export const prLineSchema = z.object({
  itemId: id(),
  qty: z.coerce.number().positive(),
  needByDate: date().optional(),
});
export type PrLineDto = z.infer<typeof prLineSchema>;

export const createPrSchema = z.object({
  projectId: optId(),
  wbsId: optId(),
  requiredDate: date().optional(),
  lines: z.array(prLineSchema).min(1, 'At least one line is required').max(200),
});
export type CreatePrDto = z.infer<typeof createPrSchema>;

// ---- Purchase Order --------------------------------------------------------

export const poLineSchema = z.object({
  itemId: id(),
  qty: z.coerce.number().positive(),
  unitRate: z.coerce.number().min(0),
  needByDate: date().optional(),
});
export type PoLineDto = z.infer<typeof poLineSchema>;

export const createPoSchema = z.object({
  vendorId: id(),
  projectId: optId(),
  prId: optId(),
  expectedDate: date().optional(),
  lines: z.array(poLineSchema).min(1, 'At least one line is required').max(200),
});
export type CreatePoDto = z.infer<typeof createPoSchema>;

// ---- Goods Receipt ---------------------------------------------------------

export const grnLineSchema = z.object({
  poLineId: optId(),
  itemId: id(),
  receivedQty: z.coerce.number().positive(),
  acceptedQty: z.coerce.number().min(0).optional(),
  rejectedQty: z.coerce.number().min(0).optional(),
});
export type GrnLineDto = z.infer<typeof grnLineSchema>;

export const receiveGrnSchema = z.object({
  poId: id(),
  warehouseId: optId(),
  lines: z.array(grnLineSchema).min(1, 'At least one line is required').max(200),
});
export type ReceiveGrnDto = z.infer<typeof receiveGrnSchema>;

/**
 * One-click "receive everything outstanding" on a PO: the lines are derived
 * server-side from the PO's remaining quantity, so the only (optional) input is
 * the receive warehouse. An empty body is valid (defaults the warehouse).
 */
export const receiveAllSchema = z.object({
  warehouseId: optId(),
});
export type ReceiveAllDto = z.infer<typeof receiveAllSchema>;

// ---- shared (optimistic concurrency / list) --------------------------------

export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

export const prListQuerySchema = z.object({
  status: z.enum(PR_STATUS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type PrListQueryDto = z.infer<typeof prListQuerySchema>;

export const poListQuerySchema = z.object({
  status: z.enum(PO_STATUS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type PoListQueryDto = z.infer<typeof poListQuerySchema>;

export const grnListQuerySchema = z.object({
  status: z.enum(GRN_STATUS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type GrnListQueryDto = z.infer<typeof grnListQuerySchema>;
