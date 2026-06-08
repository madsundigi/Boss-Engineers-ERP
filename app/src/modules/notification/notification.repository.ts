import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { Notification, NotificationListResult } from './notification.types';
import { ListQueryDto } from './notification.dto';

/** Columns of sec.notification (created in migration 030). */
const COLS = `notification_id, company_id, user_id, category, title, body, link,
  is_read, read_at, created_at, created_by`;

function mapNotification(r: QueryResultRow): Notification {
  return {
    notificationId: Number(r.notification_id),
    companyId: Number(r.company_id),
    userId: Number(r.user_id),
    category: r.category,
    title: r.title,
    body: r.body,
    link: r.link,
    isRead: r.is_read,
    readAt: r.read_at,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
  };
}

/** Fields accepted by an insert (the recipient + content). */
export interface NotificationInput {
  userId: number;
  category: string;
  title: string;
  body?: string;
  link?: string;
}

export class NotificationRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert a notification for a recipient. company_id = ctx.companyId so the row
   * satisfies the per-company RLS WITH CHECK; created_by = the acting user. No
   * outbox event — delivery is an in-app read of sec.notification.
   */
  async insert(ctx: RequestContext, n: NotificationInput): Promise<Notification> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO sec.notification
           (company_id, user_id, category, title, body, link, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLS}`,
        [ctx.companyId, n.userId, n.category, n.title, n.body ?? null, n.link ?? null, ctx.userId]);
      return mapNotification(res.rows[0]);
    });
  }

  /**
   * Fan a notification out to every active, non-deleted user holding a role
   * (one row per recipient) in a single statement. Returns the number created.
   */
  async insertForRole(ctx: RequestContext, roleCode: string, n: Omit<NotificationInput, 'userId'>): Promise<number> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO sec.notification
           (company_id, user_id, category, title, body, link, created_by)
         SELECT $1, u.user_id, $2, $3, $4, $5, $6
           FROM sec.app_user u
           JOIN sec.user_role ur ON ur.user_id = u.user_id
           JOIN sec.role r       ON r.role_id  = ur.role_id
          WHERE r.role_code = $7 AND u.is_active AND NOT u.is_deleted`,
        [ctx.companyId, n.category, n.title, n.body ?? null, n.link ?? null, ctx.userId, roleCode]);
      return res.rowCount ?? 0;
    });
  }

  /** The caller's own unread count (scoped to the tenant). */
  private async unreadCount(c: Queryable, ctx: RequestContext): Promise<number> {
    const res = await c.query<{ c: string }>(
      `SELECT count(*)::text c FROM sec.notification
        WHERE company_id = $1 AND user_id = $2 AND NOT is_read`,
      [ctx.companyId, ctx.userId]);
    return Number(res.rows[0].c);
  }

  /**
   * The caller's own notifications (WHERE user_id = ctx.userId), newest first,
   * paginated. Always returns the caller's full unread count (not just the page
   * or the unreadOnly slice) so the UI badge is accurate.
   */
  async listMine(ctx: RequestContext, q: ListQueryDto): Promise<NotificationListResult> {
    const where: string[] = ['company_id = $1', 'user_id = $2'];
    const params: unknown[] = [ctx.companyId, ctx.userId];
    if (q.unreadOnly) where.push('NOT is_read');
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM sec.notification WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${COLS} FROM sec.notification WHERE ${w}
          ORDER BY created_at DESC, notification_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      const unreadCount = await this.unreadCount(c, ctx);
      return { rows: rows.rows.map(mapNotification), total, unreadCount, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Mark ONE of the caller's own notifications read (WHERE user_id = ctx.userId)
   * — already-read rows are a no-op match. Returns the row, or null when it is
   * not the caller's (so the service can 404). Idempotent.
   */
  async markRead(ctx: RequestContext, id: number): Promise<Notification | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE sec.notification
            SET is_read = true, read_at = COALESCE(read_at, now())
          WHERE notification_id = $1 AND company_id = $2 AND user_id = $3
        RETURNING ${COLS}`,
        [id, ctx.companyId, ctx.userId]);
      return res.rowCount ? mapNotification(res.rows[0]) : null;
    });
  }

  /** Mark ALL the caller's unread notifications read. Returns the count flipped. */
  async markAllRead(ctx: RequestContext): Promise<number> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE sec.notification
            SET is_read = true, read_at = now()
          WHERE company_id = $1 AND user_id = $2 AND NOT is_read`,
        [ctx.companyId, ctx.userId]);
      return res.rowCount ?? 0;
    });
  }
}
