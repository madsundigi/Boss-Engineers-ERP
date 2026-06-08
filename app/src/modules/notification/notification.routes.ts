import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { NotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NOTIFICATION_PERMS } from './notification.constants';
import { raiseNotificationSchema, broadcastNotificationSchema, listQuerySchema } from './notification.dto';

/**
 * Compose the Notifications module (repository -> service -> controller) and its
 * routes. raise / broadcast write to (possibly ANOTHER) user's inbox so they are
 * guarded by NOTIFICATION.CREATE; list-mine / mark-read / mark-all-read only ever
 * touch the CALLER's own rows (scoped by user_id) so they need only NOTIFICATION.VIEW.
 */
export function notificationRouter(pool: Pool): Router {
  const controller = new NotificationController(new NotificationService(new NotificationRepository(pool)));
  const r = Router();
  const P = NOTIFICATION_PERMS;

  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.listMine));

  r.post('/',
    requirePermission(P.CREATE),
    validate(raiseNotificationSchema),
    asyncHandler(controller.raise));

  // Fan a notification out to every active user holding a role.
  r.post('/broadcast',
    requirePermission(P.CREATE),
    validate(broadcastNotificationSchema),
    asyncHandler(controller.broadcast));

  // Mark all the caller's unread read — must precede '/:id/read' on the literal.
  r.post('/read-all',
    requirePermission(P.VIEW),
    asyncHandler(controller.markAllRead));

  // Mark one of the caller's own notifications read (404 if not theirs).
  r.post('/:id/read',
    requirePermission(P.VIEW),
    asyncHandler(controller.markRead));

  return r;
}
