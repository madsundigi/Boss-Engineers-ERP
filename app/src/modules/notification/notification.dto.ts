import { z } from 'zod';
import { NOTIFICATION_CATEGORY } from './notification.constants';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();

/**
 * POST /api/notifications — raise a notification for a recipient. userId is the
 * recipient (defaults to the caller when omitted). category defaults to INFO.
 * company_id + created_by come from context.
 */
export const raiseNotificationSchema = z.object({
  userId: id.optional(),
  category: z.enum(NOTIFICATION_CATEGORY).default('INFO'),
  title: t(200).min(1, 'A title is required'),
  body: t(1000).optional(),
  link: t(300).optional(),
});
export type RaiseNotificationDto = z.infer<typeof raiseNotificationSchema>;

/**
 * POST /api/notifications/broadcast — fan a notification out to every active
 * user holding a role. roleCode is the target role; the rest mirrors `raise`.
 */
export const broadcastNotificationSchema = z.object({
  roleCode: t(40).min(1, 'A roleCode is required'),
  category: z.enum(NOTIFICATION_CATEGORY).default('INFO'),
  title: t(200).min(1, 'A title is required'),
  body: t(1000).optional(),
  link: t(300).optional(),
});
export type BroadcastNotificationDto = z.infer<typeof broadcastNotificationSchema>;

/** GET /api/notifications — the caller's own list: filters + pagination. */
export const listQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
