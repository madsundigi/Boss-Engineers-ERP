import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { hashPassword, validatePasswordPolicy } from '../../common/password';
import { UserRepository } from './users.repository';
import { AppUser, UserListResult, RoleCatalogEntry } from './users.types';
import {
  CreateUserDto, UpdateUserDto, AssignRolesDto, ResetPasswordDto, ListQueryDto,
} from './users.dto';
import { ADMIN_ROLE_CODE } from './users.constants';

/**
 * UserService — business logic for User & Role Administration. Stateless; depends
 * only on the injected repository so it is unit-testable without a database.
 *
 * Responsibilities:
 *  - enforce the password complexity policy (validatePasswordPolicy) and hash with
 *    scrypt (hashPassword) — plain text is never persisted or returned;
 *  - resolve role codes to ids and reject unknown codes (400);
 *  - map duplicate username -> 409 and row-version conflicts -> 409;
 *  - enforce the self-lockout safeguards: you cannot deactivate or delete your own
 *    account, and you cannot strip ADMIN from your own account.
 */
export class UserService {
  constructor(private readonly repo: UserRepository) {}

  /** Throw 400 with the human-readable violations if the password fails policy. */
  private assertPasswordPolicy(password: string): void {
    const violations = validatePasswordPolicy(password);
    if (violations.length > 0) {
      throw Errors.badRequest('Password does not meet the complexity policy', { violations });
    }
  }

  /** Resolve role codes -> ids; reject any code that does not exist (400). */
  private async resolveRoles(ctx: RequestContext, codes: string[]): Promise<number[]> {
    const { ids, unknown } = await this.repo.resolveRoleIds(ctx, codes);
    if (unknown.length > 0) {
      throw Errors.badRequest(`Unknown role code(s): ${unknown.join(', ')}`, { unknown });
    }
    return ids;
  }

  async create(ctx: RequestContext, dto: CreateUserDto): Promise<AppUser> {
    this.assertPasswordPolicy(dto.password);
    // Resolve + validate roles BEFORE inserting so an unknown code never leaves a
    // half-created (role-less) user behind.
    const roleIds = await this.resolveRoles(ctx, dto.roleCodes);
    // Pre-check the username for a clean 409 (the unique index is the backstop).
    if (await this.repo.usernameExists(ctx, dto.username)) {
      throw Errors.conflict(`Username '${dto.username}' is already taken`);
    }
    try {
      return await this.repo.create(ctx, {
        username: dto.username,
        email: dto.email,
        fullName: dto.fullName,
        passwordHash: hashPassword(dto.password),
        employeeId: dto.employeeId,
      }, roleIds);
    } catch (e) {
      // Race on the unique username (or email) index between the pre-check and the
      // insert: surface as a 409 rather than a 500.
      if (isUniqueViolation(e)) {
        throw Errors.conflict(`Username '${dto.username}' is already taken`);
      }
      throw e;
    }
  }

  async getById(ctx: RequestContext, id: number): Promise<AppUser> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`User ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<UserListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateUserDto): Promise<AppUser> {
    const { rowVersion, ...fields } = dto;
    if (fields.email === undefined && fields.fullName === undefined && fields.isActive === undefined) {
      throw Errors.badRequest('No fields supplied to update');
    }
    // SAFETY: an admin may not deactivate their OWN account (avoid self-lockout).
    if (fields.isActive === false && ctx.userId === id) {
      throw Errors.badRequest('You cannot deactivate yourself');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    const updated = await this.repo.updateProfile(ctx, id, rowVersion, fields);
    if (!updated) {
      throw Errors.conflict('User was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Replace the user's full set of roles. SAFETY: a user may not remove ADMIN from
   * their OWN account (prevents an administrator locking everyone out of user
   * administration). Unknown role codes -> 400.
   */
  async assignRoles(ctx: RequestContext, id: number, dto: AssignRolesDto): Promise<AppUser> {
    await this.getById(ctx, id); // 404 if missing
    if (ctx.userId === id && !dto.roleCodes.includes(ADMIN_ROLE_CODE)) {
      throw Errors.badRequest('You cannot remove the ADMIN role from your own account');
    }
    const roleIds = await this.resolveRoles(ctx, dto.roleCodes);
    const updated = await this.repo.replaceRoles(ctx, id, roleIds);
    if (!updated) throw Errors.notFound(`User ${id} not found`);
    return updated;
  }

  /** Admin reset of another user's password: policy-check + hash + bump version. */
  async resetPassword(ctx: RequestContext, id: number, dto: ResetPasswordDto): Promise<void> {
    this.assertPasswordPolicy(dto.password);
    await this.getById(ctx, id); // 404 if missing
    const ok = await this.repo.updatePassword(ctx, id, hashPassword(dto.password));
    if (!ok) throw Errors.notFound(`User ${id} not found`);
  }

  /** Soft-delete a user. SAFETY: you cannot delete your own account. */
  async delete(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    if (ctx.userId === id) {
      throw Errors.badRequest('You cannot delete your own account');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    const ok = await this.repo.softDelete(ctx, id, rowVersion);
    if (!ok) {
      throw Errors.conflict('User was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
  }

  /** Read-only role catalog (ROLE_MGMT.VIEW): role -> permission codes. */
  roleCatalog(ctx: RequestContext): Promise<RoleCatalogEntry[]> {
    return this.repo.roleCatalog(ctx);
  }
}

/** Postgres unique_violation (SQLSTATE 23505) — a duplicate username/email race. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
