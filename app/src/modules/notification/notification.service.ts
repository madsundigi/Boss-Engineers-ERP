import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { NotificationRepository, NotificationInput } from './notification.repository';
import { Notification, NotificationListResult } from './notification.types';
import { RaiseNotificationDto, BroadcastNotificationDto, ListQueryDto } from './notification.dto';

/**
 * NotificationService — business logic for the per-user notification store.
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. Any module/user RAISES a notification for a recipient
 * (default = the caller); every user LISTS + MARK-READs their OWN notifications
 * (scoped by user_id), so reads + mark-read only ever touch the caller's rows.
 * No outbox event — delivery is an in-app read of sec.notification.
 */
export class NotificationService {
  constructor(private readonly repo: NotificationRepository) {}

  /**
   * Raise a notification for a recipient (defaults to ctx.userId when userId is
   * omitted). Guarded upstream by NOTIFICATION.CREATE because it may write to
   * ANOTHER user's inbox.
   */
  raise(ctx: RequestContext, dto: RaiseNotificationDto): Promise<Notification> {
    const input: NotificationInput = {
      userId: dto.userId ?? ctx.userId,
      category: dto.category,
      title: dto.title,
      body: dto.body,
      link: dto.link,
    };
    return this.repo.insert(ctx, input);
  }

  /**
   * Broadcast a notification to every active user holding a role (fan-out, one
   * row each). Guarded by NOTIFICATION.CREATE. Returns how many were created.
   */
  async broadcast(ctx: RequestContext, dto: BroadcastNotificationDto): Promise<{ created: number }> {
    const created = await this.repo.insertForRole(ctx, dto.roleCode, {
      category: dto.category,
      title: dto.title,
      body: dto.body,
      link: dto.link,
    });
    return { created };
  }

  /** The caller's own notifications (newest first, paginated, + unreadCount). */
  listMine(ctx: RequestContext, query: ListQueryDto): Promise<NotificationListResult> {
    return this.repo.listMine(ctx, query);
  }

  /**
   * Mark ONE of the caller's own notifications read. 404 when the notification
   * is not the caller's (or does not exist) — a user can only mark THEIR OWN.
   * Idempotent (already-read is a no-op).
   */
  async markRead(ctx: RequestContext, id: number): Promise<Notification> {
    const row = await this.repo.markRead(ctx, id);
    if (!row) throw Errors.notFound(`Notification ${id} not found`);
    return row;
  }

  /** Mark all the caller's unread notifications read; return the count flipped. */
  async markAllRead(ctx: RequestContext): Promise<{ updated: number }> {
    const updated = await this.repo.markAllRead(ctx);
    return { updated };
  }
}
