import { z } from 'zod';
import { VENDOR_INVOICE_STATUS } from './payables.constants';

const date = () => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = () => z.coerce.number().int().positive();
const optId = () => z.coerce.number().int().positive().optional();

/**
 * A vendor-invoice line. item_id is optional (some bills are charge-only). amount
 * is the authoritative line value; qty/unit_rate are informational. The header
 * total_amount is the Σ of the line amounts (computed in the service).
 */
export const vendorInvoiceLineSchema = z.object({
  itemId: optId(),
  qty: z.coerce.number().min(0).optional(),
  unitRate: z.coerce.number().min(0).optional(),
  amount: z.coerce.number().min(0),
});
export type VendorInvoiceLineDto = z.infer<typeof vendorInvoiceLineSchema>;

/**
 * POST /api/ap-invoices — register a vendor bill in PENDING. vinvNo is the
 * SUPPLIER's own invoice number (user-supplied, required, unique per vendor).
 * Tenant/user come from the request context, never the body.
 */
export const createVendorInvoiceSchema = z.object({
  vinvNo: z.string().trim().min(1, 'The vendor invoice number is required').max(40),
  vendorId: id(),
  poId: optId(),
  grnId: optId(),
  invoiceDate: date().optional(),
  lines: z.array(vendorInvoiceLineSchema).min(1, 'At least one line is required').max(200),
});
export type CreateVendorInvoiceDto = z.infer<typeof createVendorInvoiceSchema>;

/** PATCH /api/ap-invoices/:id — replace header + lines (only while PENDING). */
export const updateVendorInvoiceSchema = z.object({
  vinvNo: z.string().trim().min(1).max(40).optional(),
  poId: optId(),
  grnId: optId(),
  invoiceDate: date().optional(),
  lines: z.array(vendorInvoiceLineSchema).min(1).max(200).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateVendorInvoiceDto = z.infer<typeof updateVendorInvoiceSchema>;

/** Optimistic-concurrency-only body (match, approve). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** POST /api/ap-invoices/:id/dispute — flag a bill in dispute with a reason. */
export const disputeSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to dispute').max(300),
  rowVersion: z.coerce.number().int().positive(),
});
export type DisputeDto = z.infer<typeof disputeSchema>;

/** GET /api/ap-invoices — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(VENDOR_INVOICE_STATUS).optional(),
  vendorId: optId(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['vinv_no', 'invoice_date', 'status', 'total_amount']).default('vinv_no'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;

/**
 * POST /api/ap-invoices/payments — record a payment against an APPROVED bill.
 * vpayNo is auto-allocated ('VPAY' series). The Σ of payments may not exceed the
 * invoice total; once it reaches the total the invoice flips to PAID.
 */
export const createPaymentSchema = z.object({
  vendorInvoiceId: id(),
  amount: z.coerce.number().positive(),
  payDate: date().optional(),
});
export type CreatePaymentDto = z.infer<typeof createPaymentSchema>;

/** GET /api/ap-invoices/payments — list payments (optionally for one invoice). */
export const paymentListQuerySchema = z.object({
  vendorId: optId(),
  vendorInvoiceId: optId(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type PaymentListQueryDto = z.infer<typeof paymentListQuerySchema>;
