import { z } from 'zod';
import { INVOICE_STATUS, REVENUE_METHOD } from './billing.constants';

const t = (n: number) => z.string().trim().max(n);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = z.coerce.number().int().positive();
const money = z.coerce.number().min(0);

/**
 * One invoice line. taxableAmount / taxAmount are computed server-side (qty x
 * unit_rate, plus the tax_code rates) and are NOT accepted from the client.
 */
const invoiceLineSchema = z.object({
  itemId: id.optional(),
  description: t(300).min(1, 'A line description is required'),
  qty: z.coerce.number().positive().default(1),
  unitRate: money.default(0),
  taxCodeId: id.optional(),
});

/**
 * POST /api/invoices — create a customer invoice in DRAFT with 1..n lines.
 * currencyId is optional on the wire: the service resolves INR when omitted.
 * Tenant / branch / user come from the request context.
 */
export const createInvoiceSchema = z.object({
  customerId: id,
  projectId: id.optional(),
  milestoneId: id.optional(),
  currencyId: id.optional(),
  invoiceDate: dateStr.optional(),
  lines: z.array(invoiceLineSchema).min(1, 'An invoice needs at least one line').max(500),
});
export type CreateInvoiceDto = z.infer<typeof createInvoiceSchema>;

/** PATCH /api/invoices/:id — replace header + lines (DRAFT only); recompute amounts. */
export const updateInvoiceSchema = z.object({
  projectId: id.optional(),
  milestoneId: id.optional(),
  currencyId: id.optional(),
  invoiceDate: dateStr.optional(),
  lines: z.array(invoiceLineSchema).min(1, 'An invoice needs at least one line').max(500),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateInvoiceDto = z.infer<typeof updateInvoiceSchema>;

/** Optimistic-concurrency-only body (post, markSent). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** POST /api/invoices/:id/cancel — abandon an invoice with a reason. */
export const cancelSchema = z.object({
  reason: t(300).min(1, 'A reason is required to cancel'),
  rowVersion: z.coerce.number().int().positive(),
});
export type CancelDto = z.infer<typeof cancelSchema>;

/** GET /api/invoices — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(INVOICE_STATUS).optional(),
  customerId: id.optional(),
  projectId: id.optional(),
  q: t(60).optional(), // free-text on invoice_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['invoice_no', 'invoice_date', 'status', 'total_amount', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;

// ---------------------------------------------------------------------
// Receipts & allocation
// ---------------------------------------------------------------------
/** One allocation of a receipt against an outstanding invoice. */
const allocationSchema = z.object({
  invoiceId: id,
  allocatedAmount: z.coerce.number().positive(),
});

/**
 * POST /api/invoices/receipts — record a customer receipt, optionally allocating
 * it across invoices. Allocation updates each touched invoice's paid status.
 */
export const createReceiptSchema = z.object({
  customerId: id,
  amount: z.coerce.number().positive(),
  receiptDate: dateStr.optional(),
  mode: t(20).optional(),
  reference: t(60).optional(),
  allocations: z.array(allocationSchema).max(200).optional(),
});
export type CreateReceiptDto = z.infer<typeof createReceiptSchema>;

/** GET /api/invoices/receipts — list filters + pagination. */
export const receiptQuerySchema = z.object({
  customerId: id.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ReceiptQueryDto = z.infer<typeof receiptQuerySchema>;

// ---------------------------------------------------------------------
// Advances
// ---------------------------------------------------------------------
/** POST /api/invoices/advances — record a project advance from a customer. */
export const createAdvanceSchema = z.object({
  projectId: id,
  customerId: id,
  amount: z.coerce.number().positive(),
  advanceDate: dateStr.optional(),
});
export type CreateAdvanceDto = z.infer<typeof createAdvanceSchema>;

/** POST /api/invoices/advances/:id/adjust — adjust (consume) part of an advance. */
export const adjustAdvanceSchema = z.object({ amount: z.coerce.number().positive() });
export type AdjustAdvanceDto = z.infer<typeof adjustAdvanceSchema>;

/** GET /api/invoices/advances — list filters. */
export const advanceQuerySchema = z.object({
  projectId: id.optional(),
  customerId: id.optional(),
});
export type AdvanceQueryDto = z.infer<typeof advanceQuerySchema>;

// ---------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------
/** POST /api/invoices/retentions — hold retention money on a project / invoice. */
export const createRetentionSchema = z.object({
  projectId: id,
  invoiceId: id.optional(),
  retainedAmount: z.coerce.number().positive(),
  releaseDueDate: dateStr.optional(),
});
export type CreateRetentionDto = z.infer<typeof createRetentionSchema>;

/** POST /api/invoices/retentions/:id/release — release (part of) held retention. */
export const releaseRetentionSchema = z.object({ amount: z.coerce.number().positive() });
export type ReleaseRetentionDto = z.infer<typeof releaseRetentionSchema>;

/** GET /api/invoices/retentions — list filters. */
export const retentionQuerySchema = z.object({ projectId: id.optional() });
export type RetentionQueryDto = z.infer<typeof retentionQuerySchema>;

// ---------------------------------------------------------------------
// Revenue recognition
// ---------------------------------------------------------------------
/** POST /api/invoices/revenue — append a revenue-recognition entry. */
export const recognizeRevenueSchema = z.object({
  projectId: id,
  milestoneId: id.optional(),
  recognitionDate: dateStr.optional(),
  method: z.enum(REVENUE_METHOD).optional(),
  amount: z.coerce.number().positive(),
});
export type RecognizeRevenueDto = z.infer<typeof recognizeRevenueSchema>;
