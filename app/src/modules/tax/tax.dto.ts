import { z } from 'zod';
import { SUPPLY_TYPES } from './tax.constants';

const t = (n: number) => z.string().trim().max(n);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const rate = z.coerce.number().min(0, 'A GST rate cannot be negative');

/**
 * POST /api/tax/codes — create a GST rate-master entry. code is unique (a global
 * key, e.g. 'GST18'); each rate is a non-negative percentage. The split between
 * cgst/sgst and igst is the user's to define (this module does not derive it on
 * the master, only on the transaction at e-invoice time).
 */
export const createTaxCodeSchema = z.object({
  code: t(20).min(1, 'A tax code is required'),
  cgstRate: rate.optional(),
  sgstRate: rate.optional(),
  igstRate: rate.optional(),
  isActive: z.boolean().optional(),
});
export type CreateTaxCodeDto = z.infer<typeof createTaxCodeSchema>;

/** PATCH /api/tax/codes/:id/active — flip is_active (no row_version; simple master). */
export const setActiveSchema = z.object({ isActive: z.boolean() });
export type SetActiveDto = z.infer<typeof setActiveSchema>;

/** GET /api/tax/codes — list filter. */
export const taxCodeQuerySchema = z.object({
  isActive: z.coerce.boolean().optional(),
});
export type TaxCodeQueryDto = z.infer<typeof taxCodeQuerySchema>;

/**
 * POST /api/tax/invoices/:invoiceId/einvoice — generate the IRN for an invoice.
 * supplyType drives the GST split (INTRA -> CGST+SGST, INTER -> IGST). The
 * invoiceId is taken from the path; the body carries only supplyType.
 */
export const generateEInvoiceSchema = z.object({
  supplyType: z.enum(SUPPLY_TYPES),
});
export type GenerateEInvoiceDto = z.infer<typeof generateEInvoiceSchema>;

/**
 * POST /api/tax/invoices/:invoiceId/ewaybill — generate the e-way bill number.
 * The invoice must already carry an IRN (e-invoice first). All carrier details
 * are optional. `transporter` is kept for backward compatibility; the new
 * `transporterId` (NIC transporter GSTIN/TransId), `transportMode` and
 * `distanceKm` feed the live NIC e-way-bill request when that provider is active
 * (the mock ignores them).
 */
export const generateEwayBillSchema = z.object({
  transporter: t(120).optional(),
  transporterId: t(20).optional(),
  vehicleNo: t(20).optional(),
  transportMode: z.enum(['road', 'rail', 'air', 'ship']).optional(),
  distanceKm: z.coerce.number().min(0).max(4000).optional(),
});
export type GenerateEwayBillDto = z.infer<typeof generateEwayBillSchema>;

/** GET /api/tax/transactions — list filters + pagination over the GST ledger. */
export const txnQuerySchema = z.object({
  docType: t(20).optional(),
  fromDate: dateStr.optional(),
  toDate: dateStr.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type TxnQueryDto = z.infer<typeof txnQuerySchema>;

/** GET /api/tax/summary — GSTR-style liability totals over a date range (inclusive). */
export const summaryQuerySchema = z.object({
  fromDate: dateStr,
  toDate: dateStr,
});
export type SummaryQueryDto = z.infer<typeof summaryQuerySchema>;
