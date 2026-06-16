import { z } from 'zod';
import { FOLLOWUP_TYPE, FOLLOWUP_CHANNEL } from './followup.constants';

const trimmed = (max: number) => z.string().trim().max(max);
const ymd = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** GET /followups?enquiryId=N — the trail for one enquiry. */
export const listQuerySchema = z.object({
  enquiryId: z.coerce.number().int().positive(),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;

/**
 * POST /followups — log the next follow-up in an enquiry's trail. A VIRTUAL
 * follow-up needs a channel; a PHYSICAL one needs a location (enforced by the
 * refinements below). seq + status are server-assigned.
 */
export const createFollowupSchema = z
  .object({
    enquiryId: z.coerce.number().int().positive(),
    followupType: z.enum(FOLLOWUP_TYPE),
    channel: z.enum(FOLLOWUP_CHANNEL).optional(),
    channelOther: trimmed(60).optional(),
    location: trimmed(300).optional(),
    scheduledDate: ymd,
    notes: trimmed(8000).optional(),
  })
  .refine((v) => v.followupType !== 'VIRTUAL' || !!v.channel, {
    message: 'A channel is required for a VIRTUAL follow-up',
    path: ['channel'],
  })
  .refine((v) => v.followupType !== 'PHYSICAL' || !!(v.location && v.location.length), {
    message: 'A location is required for a PHYSICAL follow-up',
    path: ['location'],
  });
export type CreateFollowupDto = z.infer<typeof createFollowupSchema>;

/** PATCH /followups/:id — close out / reschedule under optimistic concurrency. */
export const updateFollowupSchema = z.object({
  status: z.enum(['DONE', 'CANCELLED', 'PENDING']).optional(),
  outcome: trimmed(8000).optional(),
  notes: trimmed(8000).optional(),
  scheduledDate: ymd.optional(),
  rowVersion: z.coerce.number().int().positive(),
});
export type UpdateFollowupDto = z.infer<typeof updateFollowupSchema>;

/** GET /followups/dashboard?mine=true — optionally scope to the caller's items. */
export const dashboardQuerySchema = z.object({
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type DashboardQueryDto = z.infer<typeof dashboardQuerySchema>;
