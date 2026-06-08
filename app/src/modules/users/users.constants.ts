/** Domain constants for the User & Role Administration module.
 *
 * This module exposes USER MANAGEMENT (create users, assign the existing
 * least-privilege roles, reset passwords, activate/deactivate) plus a READ-ONLY
 * ROLE CATALOG. It does NOT define roles or permissions — the 12 roles and their
 * grants are seeded in db/08_rbac.sql; here we only let an admin map users onto
 * them so the system stops running with everyone as a superuser.
 *
 * sec.app_user is a GLOBAL security table: no company_id, no RLS. The repository
 * runs as erp_app via runInContext/runRead and reads/writes all rows — only
 * holders of the USER_MGMT.* / ROLE_MGMT.* permissions (ADMIN) ever reach this
 * code, so the RBAC guard is the access boundary, not row-level security.
 */

/**
 * RBAC permission codes for this module (seeded in db/08_rbac.sql; ADMIN holds
 * USER_MGMT.VCEDAX and ROLE_MGMT.VCEDAX, CEO holds the VIEW of each).
 *   reads (list/get users + roles-of-user) -> USER_MGMT.VIEW
 *   create user                            -> USER_MGMT.CREATE
 *   update / assign-roles / reset-password / deactivate -> USER_MGMT.EDIT
 *   soft-delete a user                     -> USER_MGMT.DELETE
 *   the role catalog (GET /api/roles)      -> ROLE_MGMT.VIEW
 */
export const USER_PERMS = {
  VIEW: 'USER_MGMT.VIEW',
  CREATE: 'USER_MGMT.CREATE',
  EDIT: 'USER_MGMT.EDIT',
  DELETE: 'USER_MGMT.DELETE',
  EXPORT: 'USER_MGMT.EXPORT',
} as const;

export const ROLE_PERMS = {
  VIEW: 'ROLE_MGMT.VIEW',
} as const;

/**
 * The privileged role whose removal from one's OWN account is blocked, so an
 * administrator can never lock themselves (and potentially everyone) out of user
 * administration by stripping their own ADMIN grant.
 */
export const ADMIN_ROLE_CODE = 'ADMIN';
