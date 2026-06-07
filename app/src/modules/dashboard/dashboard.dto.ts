import { z } from 'zod';

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/**
 * Optional query params shared by the dashboard read endpoints. The KPI summary is
 * "as of now" and needs no input, but an optional date window is accepted (and
 * validated) for forward compatibility / export labelling. `to` must not precede
 * `from` when both are supplied.
 */
export const dashboardQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: '`from` must be on or before `to`',
    path: ['to'],
  });
export type DashboardQueryDto = z.infer<typeof dashboardQuerySchema>;
