import { z } from 'zod';
import { CUSTOMER_TYPES, CUSTOMER_STATUSES } from './customers.constants';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();
/** credit_limit is numeric(20,4); non-negative. */
const money = z.coerce.number().min(0);

/**
 * POST /api/customers — create a customer. customer_code is user-supplied and globally
 * UNIQUE (the DB enforces it; the service maps the 23505 to a 409). defaultCurrencyId is
 * required (FK -> mdm.currency). Tenant / user come from request context — never the body.
 */
export const createCustomerSchema = z.object({
  customerCode: t(20).min(1, 'A customer code is required'),
  customerName: t(150).min(1, 'A customer name is required'),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  gstin: t(15).optional(),
  pan: t(10).optional(),
  creditLimit: money.optional(),
  paymentTermId: id.optional(),
  defaultCurrencyId: id,
  status: z.enum(CUSTOMER_STATUSES).optional(),
});
export type CreateCustomerDto = z.infer<typeof createCustomerSchema>;

/** PATCH /api/customers/:id — edit a customer. customer_code is immutable (the stable
 *  business key). All fields optional except the optimistic-concurrency rowVersion. */
export const updateCustomerSchema = z.object({
  customerName: t(150).min(1).optional(),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  gstin: t(15).optional(),
  pan: t(10).optional(),
  creditLimit: money.optional(),
  paymentTermId: id.optional(),
  defaultCurrencyId: id.optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateCustomerDto = z.infer<typeof updateCustomerSchema>;

/** Optimistic-concurrency-only body (soft delete via the query string). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** GET /api/customers — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(CUSTOMER_STATUSES).optional(),
  q: t(60).optional(), // free-text on customer_code + customer_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['customer_code', 'customer_name', 'created_at']).default('customer_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
