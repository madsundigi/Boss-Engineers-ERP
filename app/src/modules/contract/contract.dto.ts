import { z } from 'zod';
import { CONTRACT_STATUS } from './contract.constants';

const t = (n: number) => z.string().trim().max(n);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = z.coerce.number().int().positive();
const money = z.coerce.number().min(0);
const pct = z.coerce.number().min(0).max(100);

/**
 * One billing milestone on the contract. milestonePct is the share of the
 * contract value this milestone bills; amount is the absolute figure (the service
 * derives it from the pct + contract value when only a pct is supplied).
 */
const milestoneSchema = z.object({
  name: t(200).min(1, 'A milestone name is required'),
  milestonePct: pct.optional(),
  amount: money.optional(),
  dueDate: dateStr.optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

/**
 * POST /api/contracts — create a commercial customer contract in DRAFT with an
 * optional billing-milestone schedule. currencyId is optional on the wire: the
 * service resolves INR when omitted. Tenant / branch / user come from context.
 */
export const createContractSchema = z.object({
  customerId: id,
  projectId: id.optional(),
  title: t(200).optional(),
  contractValue: money.default(0),
  currencyId: id.optional(),
  paymentTerms: t(300).optional(),
  ldPenaltyPct: pct.optional(),
  ldCapPct: pct.optional(),
  warrantyMonths: z.coerce.number().int().min(0).optional(),
  startDate: dateStr.optional(),
  endDate: dateStr.optional(),
  signedDate: dateStr.optional(),
  milestones: z.array(milestoneSchema).max(200).optional(),
});
export type CreateContractDto = z.infer<typeof createContractSchema>;

/** PATCH /api/contracts/:id — edit header + replace milestones (DRAFT only). */
export const updateContractSchema = z.object({
  projectId: id.optional(),
  title: t(200).optional(),
  contractValue: money.optional(),
  currencyId: id.optional(),
  paymentTerms: t(300).optional(),
  ldPenaltyPct: pct.optional(),
  ldCapPct: pct.optional(),
  warrantyMonths: z.coerce.number().int().min(0).optional(),
  startDate: dateStr.optional(),
  endDate: dateStr.optional(),
  signedDate: dateStr.optional(),
  milestones: z.array(milestoneSchema).max(200).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateContractDto = z.infer<typeof updateContractSchema>;

/** Optimistic-concurrency-only body (activate, close, milestone transitions). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** POST /api/contracts/:id/cancel — abandon a contract with a reason. */
export const cancelSchema = z.object({
  reason: t(300).min(1, 'A reason is required to cancel'),
  rowVersion: z.coerce.number().int().positive(),
});
export type CancelDto = z.infer<typeof cancelSchema>;

/** GET /api/contracts — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(CONTRACT_STATUS).optional(),
  customerId: id.optional(),
  projectId: id.optional(),
  q: t(60).optional(), // free-text on contract_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['contract_no', 'start_date', 'status', 'contract_value', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
