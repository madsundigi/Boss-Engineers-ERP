import { z } from 'zod';
import { QUOTE_STATUS } from './quotation.constants';

const t = (n: number) => z.string().trim().max(n);

export const lineSchema = z.object({
  description: t(300).min(1),
  qty: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  isOptional: z.coerce.boolean().optional().default(false),
});
export type LineDto = z.infer<typeof lineSchema>;

export const createQuotationSchema = z.object({
  subject: t(200).optional(),
  customerName: t(160).min(1, 'Customer Name is required'),
  contact: t(120).optional(),
  email: z.string().trim().email().max(160).optional(),
  validUntil: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  currencyCode: t(3).optional().default('INR'),
  totalCost: z.coerce.number().min(0).default(0),
  discountPct: z.coerce.number().min(0).max(100).optional().default(0),
  lines: z.array(lineSchema).min(1, 'At least one line is required').max(500),
  enquiryId: z.coerce.number().int().positive().optional(),
});
export type CreateQuotationDto = z.infer<typeof createQuotationSchema>;

export const updateQuotationSchema = z.object({
  subject: t(200).optional(),
  customerName: t(160).min(1).optional(),
  contact: t(120).optional(),
  email: z.string().trim().email().max(160).optional(),
  validUntil: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currencyCode: t(3).optional(),
  totalCost: z.coerce.number().min(0).optional(),
  discountPct: z.coerce.number().min(0).max(100).optional(),
  lines: z.array(lineSchema).min(1).max(500).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type UpdateQuotationDto = z.infer<typeof updateQuotationSchema>;

/** Create a draft quotation from a qualified enquiry (sync). */
export const convertSchema = z.object({
  subject: t(200).optional(),
  validUntil: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currencyCode: t(3).optional().default('INR'),
});
export type ConvertDto = z.infer<typeof convertSchema>;

export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export const decisionSchema = z.object({
  rowVersion: z.coerce.number().int().positive(),
  reason: t(300).optional(),
});
export const reviseSchema = z.object({
  rowVersion: z.coerce.number().int().positive(),
  reason: t(300).min(1, 'A revision reason is required'),
});
export const sendSchema = z.object({
  rowVersion: z.coerce.number().int().positive(),
  to: z.string().trim().email().optional(),
  cc: z.string().trim().email().optional(),
  message: t(2000).optional(),
});
export type SendDto = z.infer<typeof sendSchema>;

export const listQuerySchema = z.object({
  status: z.enum(QUOTE_STATUS).optional(),
  q: t(160).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['quotation_no', 'customer_name', 'status', 'total_price', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
