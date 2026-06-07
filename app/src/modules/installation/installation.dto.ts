import { z } from 'zod';
import { INSTALLATION_STATUS, PUNCH_STATUS } from './installation.constants';

const t = (n: number) => z.string().trim().max(n);
const ymd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** A SAT / commissioning punch-list defect found on site. */
const punchItemSchema = z.object({
  description: t(400).min(1, 'A punch-item description is required'),
  severity: t(10).optional(),
  status: z.enum(PUNCH_STATUS).default('OPEN'),
  closedDate: ymd.optional(),
});

/**
 * POST /api/installations — create a project-pegged installation in PLANNED.
 * dispatchId links the shipment whose goods are being installed; the punch list
 * is optional at create. Tenant/user/branch come from context, never the body.
 */
export const createInstallationSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  dispatchId: z.coerce.number().int().positive().optional(),
  siteAddress: t(400).optional(),
  plannedDate: ymd.optional(),
  punchItems: z.array(punchItemSchema).max(500).optional(),
});
export type CreateInstallationDto = z.infer<typeof createInstallationSchema>;

/** PATCH /api/installations/:id — edit header / punch list (PLANNED or IN_PROGRESS only). */
export const updateInstallationSchema = z.object({
  dispatchId: z.coerce.number().int().positive().optional(),
  siteAddress: t(400).optional(),
  plannedDate: ymd.optional(),
  punchItems: z.array(punchItemSchema).max(500).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateInstallationDto = z.infer<typeof updateInstallationSchema>;

/** POST /api/installations/:id/commission — record the SAT outcome (PASS/FAIL). */
export const commissionSchema = z.object({
  satResult: z.enum(['PASS', 'FAIL']),
  actualDate: ymd.optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type CommissionDto = z.infer<typeof commissionSchema>;

/** POST /api/installations/:id/accept — customer sign-off (acceptance certificate). */
export const acceptSchema = z.object({
  acceptanceCertNo: t(40).min(1, 'An acceptance certificate number is required'),
  acceptedDate: ymd.optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type AcceptDto = z.infer<typeof acceptSchema>;

/** Optimistic-concurrency-only body (start work, close). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** GET /api/installations — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(INSTALLATION_STATUS).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  q: t(60).optional(), // free-text on install_no
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['install_no', 'planned_date', 'status', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
