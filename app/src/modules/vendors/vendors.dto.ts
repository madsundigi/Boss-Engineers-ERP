import { z } from 'zod';
import { VENDOR_STATUSES } from './vendors.constants';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();
/** rating is numeric(4,2) CHECK BETWEEN 0 AND 5. */
const rating = z.coerce.number().min(0).max(5);
/** Accept a real boolean or the strings 'true'/'false' (HTML form <select> sends
 *  strings, and z.coerce.boolean turns 'false' into true — so compare by value). */
const boolish = z.preprocess(
  (v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v),
  z.boolean(),
);

/**
 * POST /api/vendors — onboard a supplier. vendor_code is user-supplied and globally
 * unique (the DB enforces it; the service maps the 23505 to a 409). Tenant / user come
 * from request context — never the body.
 */
export const createVendorSchema = z.object({
  vendorCode: t(20).min(1, 'A vendor code is required'),
  vendorName: t(150).min(1, 'A vendor name is required'),
  gstin: t(15).optional(),
  pan: t(10).optional(),
  msmeFlag: boolish.optional(),
  isApproved: boolish.optional(),
  paymentTermId: id.optional(),
  rating: rating.optional(),
  status: z.enum(VENDOR_STATUSES).optional(),
});
export type CreateVendorDto = z.infer<typeof createVendorSchema>;

/** PATCH /api/vendors/:id — edit a vendor. vendor_code is immutable (the stable
 *  business key). All fields optional except the optimistic-concurrency rowVersion. */
export const updateVendorSchema = z.object({
  vendorName: t(150).min(1).optional(),
  gstin: t(15).optional(),
  pan: t(10).optional(),
  msmeFlag: boolish.optional(),
  isApproved: boolish.optional(),
  paymentTermId: id.optional(),
  rating: rating.optional(),
  status: z.enum(VENDOR_STATUSES).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateVendorDto = z.infer<typeof updateVendorSchema>;

/** Optimistic-concurrency-only body (soft delete via the query string). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** GET /api/vendors — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(VENDOR_STATUSES).optional(),
  q: t(60).optional(), // free-text on vendor_code + vendor_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['vendor_code', 'vendor_name', 'rating', 'created_at']).default('vendor_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
