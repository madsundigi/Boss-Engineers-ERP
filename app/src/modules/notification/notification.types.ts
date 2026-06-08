import { NotificationCategory } from './notification.constants';

/**
 * A persisted notification (camelCase projection of sec.notification).
 * Append + mark-read only: no rowVersion, no soft-delete. is_read flips once via
 * markRead / markAllRead and read_at is stamped at that moment.
 */
export interface Notification {
  notificationId: number;
  companyId: number;
  userId: number;
  category: NotificationCategory;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  createdBy: number | null;
}

/**
 * The caller's own notification list — newest first, paginated, with the total
 * matching the filter and the caller's current unread count (independent of any
 * unreadOnly filter so the UI can show an accurate badge).
 */
export interface NotificationListResult {
  rows: Notification[];
  total: number;
  unreadCount: number;
  page: number;
  pageSize: number;
}
