import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { AppUser, UserListResult, RoleCatalogEntry } from './users.types';
import { ListQueryDto } from './users.dto';

/**
 * UserRepository — data access for the User & Role Administration module.
 *
 * sec.app_user / sec.user_role / sec.role are GLOBAL security tables (no
 * company_id, no RLS), so queries are NOT tenant-scoped here. We still run through
 * runInContext / runRead so the request identity lands in the session GUCs the DB
 * audit triggers read (attribution / defence in depth). erp_app holds
 * SELECT/INSERT/UPDATE on these tables out of the box; DELETE on sec.user_role is
 * granted by migration 037 so a user's roles can be replaced.
 *
 * The password hash is selected only where required (never projected to callers).
 */

/** Non-secret columns of sec.app_user (password_hash is deliberately excluded). */
const U = `user_id, username, email, full_name, employee_id, is_active, mfa_enabled,
  last_login_at, created_at, updated_at, row_version`;

type Row = Record<string, unknown>;
function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : (v as string);
}
function num(v: unknown): number | null { return v == null ? null : Number(v); }

/** Map an app_user row (+ aggregated role_codes text[]) to the camelCase projection. */
function mapUser(r: QueryResultRow): AppUser {
  const codes = (r.role_codes as string[] | null) ?? [];
  return {
    userId: Number(r.user_id),
    username: r.username as string,
    email: r.email as string,
    fullName: r.full_name as string,
    employeeId: num(r.employee_id),
    isActive: Boolean(r.is_active),
    mfaEnabled: Boolean(r.mfa_enabled),
    lastLoginAt: iso(r.last_login_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
    rowVersion: Number(r.row_version),
    roleCodes: codes.filter((c) => c != null),
  };
}

/** Header fields the service supplies to create a user (hash already computed). */
export interface CreateUserRow {
  username: string;
  email: string;
  fullName: string;
  passwordHash: string;
  employeeId?: number;
}

/** Mutable profile fields for a PATCH (each optional; undefined = leave unchanged). */
export interface UserProfileFields {
  email?: string;
  fullName?: string;
  isActive?: boolean;
}

export class UserRepository {
  constructor(private readonly pool: Pool) {}

  /** Correlated subquery that aggregates a user's role codes into a text[] so a
   *  single round-trip returns the user WITH roleCodes (empty array, never null,
   *  when the user has no roles). */
  private static readonly ROLE_CODES_SUBQUERY = `
    COALESCE((
      SELECT array_agg(r.role_code ORDER BY r.role_code)
        FROM sec.user_role ur
        JOIN sec.role r ON r.role_id = ur.role_id
       WHERE ur.user_id = au.user_id
    ), ARRAY[]::varchar[]) AS role_codes`;

  /** Resolve a set of role codes to their role_ids, returning the codes that did
   *  NOT resolve so the service can reject the request with a 400. Case is matched
   *  exactly (the DTO already upper-cased the codes). */
  async resolveRoleIds(
    ctx: RequestContext, codes: string[],
  ): Promise<{ ids: number[]; unknown: string[] }> {
    if (codes.length === 0) return { ids: [], unknown: [] };
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{ role_id: string; role_code: string }>(
        `SELECT role_id, role_code FROM sec.role
          WHERE role_code = ANY($1) AND NOT is_deleted`, [codes]);
      const found = new Map(res.rows.map((r) => [r.role_code, Number(r.role_id)]));
      const ids: number[] = [];
      const unknown: string[] = [];
      for (const code of codes) {
        const idv = found.get(code);
        if (idv == null) unknown.push(code);
        else if (!ids.includes(idv)) ids.push(idv);
      }
      return { ids, unknown };
    });
  }

  /** True if a (non-deleted) user already owns the given username — used to map a
   *  duplicate to a clean 409 before attempting the insert. */
  async usernameExists(ctx: RequestContext, username: string): Promise<boolean> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT 1 FROM sec.app_user WHERE username = $1 AND NOT is_deleted`, [username]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * Insert the user and its user_role rows in one transaction. created_by is the
   * acting admin (ctx.userId). roleIds are pre-resolved + validated by the service.
   */
  async create(ctx: RequestContext, data: CreateUserRow, roleIds: number[]): Promise<AppUser> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO sec.app_user
           (username, email, full_name, password_hash, employee_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6)
         RETURNING user_id`,
        [data.username, data.email, data.fullName, data.passwordHash,
         data.employeeId ?? null, ctx.userId]);
      const userId = Number(res.rows[0].user_id);
      await this.insertRoles(c, userId, roleIds);
      return (await this.fetchById(c, userId)) as AppUser;
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<AppUser | null> {
    return runRead(this.pool, ctx, (c) => this.fetchById(c, id));
  }

  /** Shared read used by create/update/findById so every path returns roleCodes. */
  private async fetchById(q: Queryable, id: number): Promise<AppUser | null> {
    const res = await q.query(
      `SELECT ${U}, ${UserRepository.ROLE_CODES_SUBQUERY}
         FROM sec.app_user au
        WHERE au.user_id = $1 AND NOT au.is_deleted`, [id]);
    return res.rowCount ? mapUser(res.rows[0]) : null;
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<UserListResult> {
    const where: string[] = ['NOT au.is_deleted'];
    const params: unknown[] = [];
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(au.username ILIKE $${params.length} OR au.full_name ILIKE $${params.length})`);
    }
    if (q.active) { params.push(q.active === 'true'); where.push(`au.is_active = $${params.length}`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC'; // q.sort/q.dir are enum-whitelisted
    const lim = q.pageSize; const off = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query(
        `SELECT count(*)::int AS n FROM sec.app_user au WHERE ${w}`, params)).rows[0].n);
      const rows = (await c.query(
        `SELECT ${U}, ${UserRepository.ROLE_CODES_SUBQUERY}
           FROM sec.app_user au
          WHERE ${w}
          ORDER BY au.${q.sort} ${dir}, au.user_id ASC
          LIMIT ${lim} OFFSET ${off}`, params)).rows.map(mapUser);
      return { rows, total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Optimistic-locked profile update. Returns null on a row-version mismatch. */
  async updateProfile(
    ctx: RequestContext, id: number, version: number, fields: UserProfileFields,
  ): Promise<AppUser | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    if (fields.email !== undefined) { params.push(fields.email); set.push(`email = $${params.length}`); }
    if (fields.fullName !== undefined) { params.push(fields.fullName); set.push(`full_name = $${params.length}`); }
    if (fields.isActive !== undefined) { params.push(fields.isActive); set.push(`is_active = $${params.length}`); }
    if (set.length === 0) return this.findById(ctx, id);

    return runInContext(this.pool, ctx, async (c) => {
      params.push(ctx.userId); const pUser = params.length;
      params.push(id); const pId = params.length;
      params.push(version); const pVer = params.length;
      const res = await c.query(
        `UPDATE sec.app_user
            SET ${set.join(', ')}, updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE user_id = $${pId} AND row_version = $${pVer} AND NOT is_deleted`, params);
      if (!res.rowCount) return null;
      return this.fetchById(c, id);
    });
  }

  /**
   * Replace a user's full set of roles in one transaction: delete the existing
   * user_role rows, insert the new set. roleIds are pre-resolved by the service.
   * Returns the refreshed user (always non-null when the user exists).
   */
  async replaceRoles(ctx: RequestContext, id: number, roleIds: number[]): Promise<AppUser | null> {
    return runInContext(this.pool, ctx, async (c) => {
      await c.query(`DELETE FROM sec.user_role WHERE user_id = $1`, [id]);
      await this.insertRoles(c, id, roleIds);
      // Bump the user's row so the role change is attributed + audited like an edit.
      await c.query(
        `UPDATE sec.app_user
            SET updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE user_id = $2 AND NOT is_deleted`, [ctx.userId, id]);
      return this.fetchById(c, id);
    });
  }

  private async insertRoles(q: Queryable, userId: number, roleIds: number[]): Promise<void> {
    for (const roleId of roleIds) {
      await q.query(
        `INSERT INTO sec.user_role (user_id, role_id) VALUES ($1,$2)
           ON CONFLICT (user_id, role_id) DO NOTHING`, [userId, roleId]);
    }
  }

  /** Set a new password hash and bump row_version (admin password reset). Returns
   *  true if a (non-deleted) user row was updated. */
  async updatePassword(ctx: RequestContext, id: number, passwordHash: string): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE sec.app_user
            SET password_hash = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE user_id = $3 AND NOT is_deleted`, [passwordHash, ctx.userId, id]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  /** Soft-delete: mark deleted + inactive under optimistic concurrency. Returns
   *  false on a row-version mismatch (or already-deleted). */
  async softDelete(ctx: RequestContext, id: number, version: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE sec.app_user
            SET is_deleted = true, is_active = false,
                updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE user_id = $2 AND row_version = $3 AND NOT is_deleted`,
        [ctx.userId, id, version]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  /**
   * The read-only role catalog: every (non-deleted) role with the permission codes
   * it grants (left-joined so a role with no permissions still appears, with an
   * empty array). This is how the UI shows what each least-privilege role can do.
   */
  async roleCatalog(ctx: RequestContext): Promise<RoleCatalogEntry[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT r.role_code, r.role_name, r.description,
                COALESCE(array_agg(p.perm_code ORDER BY p.perm_code)
                         FILTER (WHERE p.perm_code IS NOT NULL), ARRAY[]::varchar[]) AS permissions
           FROM sec.role r
           LEFT JOIN sec.role_permission rp ON rp.role_id = r.role_id
           LEFT JOIN sec.permission p       ON p.permission_id = rp.permission_id
          WHERE NOT r.is_deleted
          GROUP BY r.role_id, r.role_code, r.role_name, r.description
          ORDER BY r.role_code`);
      return res.rows.map((r: Row) => ({
        roleCode: r.role_code as string,
        roleName: (r.role_name as string) ?? null,
        description: (r.description as string) ?? null,
        permissions: (r.permissions as string[]) ?? [],
      }));
    });
  }
}
