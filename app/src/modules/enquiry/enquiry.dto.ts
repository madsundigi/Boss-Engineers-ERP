import { z } from 'zod';
import { ENQUIRY_SOURCE, ENQUIRY_STATUS } from './enquiry.constants';

const trimmed = (max: number) => z.string().trim().max(max);
const ymd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** POST /enquiries — intake-capture business fields (tenant/user come from context). */
export const createEnquirySchema = z.object({
  customerName: trimmed(160).min(1, 'Customer Name is required'),
  contact: trimmed(120).optional(),
  email: z.string().trim().email('Invalid email').max(160).optional(),
  address: trimmed(2000).optional(),
  industry: trimmed(80).optional(),
  source: z.enum(ENQUIRY_SOURCE).optional(),
  requirement: trimmed(8000).optional(),
  mobile: z.string().trim().max(30).optional(),
  machineType: trimmed(120).optional(),
  application: trimmed(200).optional(),
  quantity: z.coerce.number().nonnegative().optional(),
  budget: z.coerce.number().nonnegative().optional(),
  salesExecutive: trimmed(120).optional(),
  followUpDate: ymd.optional(),
  remarks: trimmed(8000).optional(),
  // status is server-defaulted to NEW on create; not accepted from the client
});
export type CreateEnquiryDto = z.infer<typeof createEnquirySchema>;

/** PATCH /enquiries/:id — all editable fields optional (partial update). */
export const updateEnquirySchema = createEnquirySchema.partial().extend({
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateEnquiryDto = z.infer<typeof updateEnquirySchema>;

/** POST /enquiries/:id/status — guarded transition. */
export const changeStatusSchema = z.object({
  status: z.enum(ENQUIRY_STATUS),
  reason: trimmed(300).optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type ChangeStatusDto = z.infer<typeof changeStatusSchema>;

/** POST /enquiries/:id/approve — qualification sign-off. */
export const approveSchema = z.object({
  rowVersion: z.coerce.number().int().positive(),
});
export type ApproveDto = z.infer<typeof approveSchema>;

/** POST /enquiries/:id/assign — assign the lead to a salesperson. rowVersion is
 *  optional (optimistic-lock the assignment only when the client supplies it). */
export const assignSchema = z.object({
  userId: z.coerce.number().int().positive(),
  rowVersion: z.coerce.number().int().positive().optional(),
});
export type AssignDto = z.infer<typeof assignSchema>;

/** GET /enquiries — list filters + pagination (all from query string). */
export const listQuerySchema = z.object({
  status: z.enum(ENQUIRY_STATUS).optional(),
  source: z.enum(ENQUIRY_SOURCE).optional(),
  q: z.string().trim().max(160).optional(), // free-text on customer/contact/email
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['enquiry_no', 'customer_name', 'status', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
