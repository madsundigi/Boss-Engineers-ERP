/** Domain constants for the Notifications / Alerts module (Tier-3).
 *
 * A per-user notification store: any module/user can RAISE a notification for a
 * recipient (sec.notification) and every user can LIST + MARK-READ their own.
 * The table is append + mark-read only — there is no row_version and no
 * soft-delete (high-churn, low-value; the audit trigger is deliberately omitted).
 */

/**
 * RBAC permission codes for this module (the 'NOTIFICATION' domain is seeded in
 * migration 030 — it is NOT in the db/08 catalog). Grants:
 *   ADMIN = VCEDAX (all six),
 *   CEO   = VCX (view/create/export),
 *   VC    = VIEW+CREATE granted to PLANNING, PRODUCTION, SALES, FINANCE, QC,
 *           STORES, PURCHASE, SERVICE, INSTALL, HR — so any module/user can
 *           raise + read notifications.
 * raise (writing to ANOTHER user) -> NOTIFICATION.CREATE;
 * reads / list-mine / mark-read / mark-all-read (the caller only ever touches
 * their OWN rows, scoped by user_id) -> NOTIFICATION.VIEW;
 * broadcast (fan-out to a role) -> NOTIFICATION.CREATE;
 * soft-delete -> NOTIFICATION.DELETE; CSV export -> NOTIFICATION.EXPORT.
 */
export const NOTIFICATION_PERMS = {
  VIEW: 'NOTIFICATION.VIEW',
  CREATE: 'NOTIFICATION.CREATE',
  EDIT: 'NOTIFICATION.EDIT',
  DELETE: 'NOTIFICATION.DELETE',
  APPROVE: 'NOTIFICATION.APPROVE',
  EXPORT: 'NOTIFICATION.EXPORT',
} as const;

/** Severity / kind of a notification (sec.notification.category CHECK). */
export const NOTIFICATION_CATEGORY = ['INFO', 'WARNING', 'ERROR', 'APPROVAL'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORY)[number];
