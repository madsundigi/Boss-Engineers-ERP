import { z } from 'zod';
import { ADJUSTMENT_TYPE, CRITICAL_STATUS } from './inventory.constants';

const trimmed = (max: number) => z.string().trim().max(max);
const id = z.coerce.number().int().positive();
const qty = z.coerce.number().positive().max(1_000_000_000);

/** GET /stock — list stock balances (free vs reserved) with filters + pagination. */
export const stockListQuerySchema = z.object({
  itemId: id.optional(),
  warehouseId: id.optional(),
  projectId: id.optional(),
  q: z.string().trim().max(120).optional(), // free-text on item code / name
  onlyAvailable: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['item_code', 'qty_on_hand', 'qty_available', 'updated_at']).default('item_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type StockListQueryDto = z.infer<typeof stockListQuerySchema>;

/** POST /adjustments — create a stock adjustment / receipt / write-off (DRAFT). */
export const createAdjustmentSchema = z.object({
  itemId: id,
  warehouseId: id,
  projectId: id.optional(),
  adjType: z.enum(ADJUSTMENT_TYPE).default('RECEIPT'),
  qty,
  unitCost: z.coerce.number().min(0).max(1_000_000_000).default(0),
  reason: trimmed(300).optional(),
});
export type CreateAdjustmentDto = z.infer<typeof createAdjustmentSchema>;

/** POST /adjustments/:id/approve — approve + post to stock (write-offs need APPROVE). */
export const approveAdjustmentSchema = z.object({
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type ApproveAdjustmentDto = z.infer<typeof approveAdjustmentSchema>;

/** POST /reservations — reserve stock against a project. */
export const createReservationSchema = z.object({
  projectId: id,
  wbsId: id.optional(),
  itemId: id,
  warehouseId: id,
  qty,
});
export type CreateReservationDto = z.infer<typeof createReservationSchema>;

/** POST /issues — issue stock to a project / work order (availability-checked). */
export const createIssueSchema = z.object({
  projectId: id,
  woId: id.optional(),
  itemId: id,
  warehouseId: id,
  qty,
  unitCost: z.coerce.number().min(0).max(1_000_000_000).default(0),
});
export type CreateIssueDto = z.infer<typeof createIssueSchema>;

/** GET /critical-items — critical-item early-warning register. */
export const criticalListQuerySchema = z.object({
  projectId: id.optional(),
  status: z.enum(CRITICAL_STATUS).optional(),
  warningOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type CriticalListQueryDto = z.infer<typeof criticalListQuerySchema>;
