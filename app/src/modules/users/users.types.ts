/**
 * camelCase projections for the User & Role Administration module
 * (sec.app_user + sec.user_role/sec.role for users; sec.role + role_permission +
 * permission for the read-only catalog). The password hash is NEVER part of any
 * projection returned to a caller.
 */

/** A user account with its assigned least-privilege role codes. */
export interface AppUser {
  userId: number;
  username: string;
  email: string;
  fullName: string;
  employeeId: number | null;
  isActive: boolean;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
  roleCodes: string[];
}

export interface UserListResult {
  rows: AppUser[];
  total: number;
  page: number;
  pageSize: number;
}

/** One entry of the read-only role catalog: a role + the permission codes it grants. */
export interface RoleCatalogEntry {
  roleCode: string;
  roleName: string | null;
  description: string | null;
  permissions: string[];
}
