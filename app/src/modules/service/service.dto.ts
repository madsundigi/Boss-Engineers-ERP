import { z } from 'zod';
import { SERVICE_TICKET_STATUS, TICKET_PRIORITY } from './service.constants';

const t = (n: number) => z.string().trim().max(n);
const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** A field visit: engineer (optional), date, hours, travel cost, notes. */
const visitSchema = z.object({
  engineerId: z.coerce.number().int().positive().optional(),
  visitDate: date.optional(),
  hours: z.coerce.number().min(0).optional(),
  travelCost: z.coerce.number().min(0).optional(),
  notes: t(1000).optional(),
});

/** A spare part issued against the ticket. */
const spareSchema = z.object({
  itemId: z.coerce.number().int().positive(),
  qty: z.coerce.number().positive(),
  unitCost: z.coerce.number().min(0).optional(),
  isChargeable: z.coerce.boolean().optional(),
});

/**
 * POST /api/service-tickets — log a complaint/breakdown in OPEN.
 * customerId is required; serialId pegs the failed unit (and lets the service
 * decide in/out of warranty); warrantyId/contractId link the cover. Tenant/user
 * come from context — never from the body.
 */
export const createTicketSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  serialId: z.coerce.number().int().positive().optional(),
  warrantyId: z.coerce.number().int().positive().optional(),
  contractId: z.coerce.number().int().positive().optional(),
  priority: z.enum(TICKET_PRIORITY).optional(),
  isInWarranty: z.coerce.boolean().optional(),
  reportedAt: z.string().trim().datetime({ offset: true }).optional(),
  slaDueAt: z.string().trim().datetime({ offset: true }).optional(),
  visits: z.array(visitSchema).max(200).optional(),
  spares: z.array(spareSchema).max(200).optional(),
});
export type CreateTicketDto = z.infer<typeof createTicketSchema>;

/** PATCH /api/service-tickets/:id — edit header / cover fields (pre-terminal). */
export const updateTicketSchema = z.object({
  priority: z.enum(TICKET_PRIORITY).optional(),
  serialId: z.coerce.number().int().positive().optional(),
  warrantyId: z.coerce.number().int().positive().optional(),
  contractId: z.coerce.number().int().positive().optional(),
  isInWarranty: z.coerce.boolean().optional(),
  slaDueAt: z.string().trim().datetime({ offset: true }).optional(),
  visits: z.array(visitSchema).max(200).optional(),
  spares: z.array(spareSchema).max(200).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateTicketDto = z.infer<typeof updateTicketSchema>;

/** POST /api/service-tickets/:id/assign — allocate a field engineer. */
export const assignSchema = z.object({
  engineerId: z.coerce.number().int().positive(),
  rowVersion: z.coerce.number().int().positive(),
});
export type AssignDto = z.infer<typeof assignSchema>;

/** POST /api/service-tickets/:id/resolve — record the resolution + close the fix. */
export const resolveSchema = z.object({
  resolution: t(4000).min(1, 'A resolution note is required'),
  rowVersion: z.coerce.number().int().positive(),
});
export type ResolveDto = z.infer<typeof resolveSchema>;

/** Optimistic-concurrency-only body (start work, close). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** POST /api/service-tickets/:id/cancel — abandon a ticket with a reason. */
export const cancelSchema = z.object({
  reason: t(300).min(1, 'A reason is required to cancel'),
  rowVersion: z.coerce.number().int().positive(),
});
export type CancelDto = z.infer<typeof cancelSchema>;

/**
 * POST /api/service-tickets/:id/warranty-claim — raise / approve a warranty claim
 * (validity + goodwill/concession). SERVICE_TICKET.APPROVE. `approve=false` (or a
 * `reject` decision) records the disposition without firing the cost event.
 */
export const warrantyClaimSchema = z.object({
  warrantyId: z.coerce.number().int().positive(),
  claimCost: z.coerce.number().min(0).optional(),
  decision: z.enum(['APPROVED', 'REJECTED']).default('APPROVED'),
  isGoodwill: z.coerce.boolean().optional(),
  note: t(500).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type WarrantyClaimDto = z.infer<typeof warrantyClaimSchema>;

/** GET /api/service-tickets — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(SERVICE_TICKET_STATUS).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  priority: z.enum(TICKET_PRIORITY).optional(),
  inWarranty: z.coerce.boolean().optional(),
  q: t(60).optional(), // free-text on ticket_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['ticket_no', 'reported_at', 'status', 'priority', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
