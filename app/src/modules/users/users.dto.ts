import { z } from 'zod';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();

/** A role code as stored in sec.role.role_code (e.g. 'SALES'). Upper-cased so the
 *  catalog lookup is case-insensitive on the wire; the service resolves it to a
 *  role_id and rejects unknown codes with 400. */
const roleCode = z.string().trim().min(1).max(40).transform((s) => s.toUpperCase());

/** A non-empty list of role codes (deduplicated). The policy check on the password
 *  itself is done in the service via validatePasswordPolicy, not here, so the
 *  human-readable violations can be returned. */
const roleCodes = z.array(roleCode).min(1, 'At least one role is required').max(20);

/** Password is NOT trimmed — leading/trailing whitespace is significant. The full
 *  complexity policy is enforced by validatePasswordPolicy in the service. */
const password = z.string().min(1).max(200);

/**
 * POST /api/users — create a user account and assign least-privilege roles.
 * password is validated against the complexity policy (validatePasswordPolicy)
 * and hashed (hashPassword) in the service; it is never stored or echoed in plain
 * text. created_by comes from the request context.
 */
export const createUserSchema = z.object({
  username: t(60).min(1, 'A username is required'),
  email: t(120).email('A valid email is required'),
  fullName: t(120).min(1, 'A full name is required'),
  password,
  roleCodes,
  employeeId: id.optional(),
});
export type CreateUserDto = z.infer<typeof createUserSchema>;

/**
 * PATCH /api/users/:id — edit mutable profile fields under optimistic concurrency.
 * A user may not deactivate THEIR OWN account (guarded in the service). At least
 * one field besides rowVersion must be supplied.
 */
export const updateUserSchema = z.object({
  email: t(120).email('A valid email is required').optional(),
  fullName: t(120).min(1).optional(),
  isActive: z.boolean().optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateUserDto = z.infer<typeof updateUserSchema>;

/** PUT /api/users/:id/roles — replace the user's full set of roles. A user may not
 *  strip ADMIN from their own account (lock-out guard in the service). */
export const assignRolesSchema = z.object({ roleCodes });
export type AssignRolesDto = z.infer<typeof assignRolesSchema>;

/** POST /api/users/:id/password — an admin resets another user's password. */
export const resetPasswordSchema = z.object({ password });
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;

/** DELETE /api/users/:id?rowVersion=N — soft-delete under optimistic concurrency. */
export const versionQuerySchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionQueryDto = z.infer<typeof versionQuerySchema>;

/** GET /api/users — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  q: t(60).optional(),                               // free-text on username / full_name
  active: z.enum(['true', 'false']).optional(),      // filter by is_active
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['username', 'full_name', 'created_at', 'last_login_at']).default('username'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
