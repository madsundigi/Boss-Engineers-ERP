import { UserService } from '../src/modules/users/users.service';
import {
  UserRepository, CreateUserRow, UserProfileFields,
} from '../src/modules/users/users.repository';
import { AppUser } from '../src/modules/users/users.types';
import { RequestContext } from '../src/common/request-context';
import { verifyPassword } from '../src/common/password';

/**
 * Unit tests for UserService — pure business logic against a hand-rolled fake
 * repository (no database, no HTTP). Focus: password policy + hashing, role-code
 * resolution, and the self-lockout safeguards. AppError exposes `statusCode`, so
 * rejections are asserted with `.rejects.toMatchObject({ statusCode })`.
 */

const STRONG = 'Test#User1234'; // passes validatePasswordPolicy (>=12, upper/lower/digit/symbol)

function ctx(userId = 1): RequestContext {
  return {
    userId,
    username: 'admin_user',
    companyId: 1,
    buId: null,
    clientIp: '127.0.0.1',
    sessionId: 'test',
    permissions: new Set<string>(),
  };
}

function userRow(over: Partial<AppUser> = {}): AppUser {
  return {
    userId: 10,
    username: 'jdoe',
    email: 'jdoe@be.test',
    fullName: 'Jane Doe',
    employeeId: null,
    isActive: true,
    mfaEnabled: false,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rowVersion: 1,
    roleCodes: ['SALES'],
    ...over,
  };
}

/**
 * Fake repository: known role codes are SALES/PLANNING/ADMIN (1/2/3); everything
 * else is "unknown". Captures the last create so the test can assert the hash.
 */
class FakeRepo {
  static ROLE_IDS: Record<string, number> = { SALES: 1, PLANNING: 2, ADMIN: 3 };

  existingUsernames = new Set<string>();
  byId = new Map<number, AppUser>();
  lastCreate?: { data: CreateUserRow; roleIds: number[] };
  lastReplaceRoles?: { id: number; roleIds: number[] };
  updateProfileResult: AppUser | null = userRow();
  softDeleteResult = true;

  async resolveRoleIds(_ctx: RequestContext, codes: string[]) {
    const ids: number[] = [];
    const unknown: string[] = [];
    for (const code of codes) {
      const id = FakeRepo.ROLE_IDS[code];
      if (id == null) unknown.push(code);
      else if (!ids.includes(id)) ids.push(id);
    }
    return { ids, unknown };
  }
  async usernameExists(_ctx: RequestContext, username: string) {
    return this.existingUsernames.has(username);
  }
  async create(_ctx: RequestContext, data: CreateUserRow, roleIds: number[]) {
    this.lastCreate = { data, roleIds };
    return userRow({ username: data.username, email: data.email, fullName: data.fullName });
  }
  async findById(_ctx: RequestContext, id: number) {
    return this.byId.get(id) ?? null;
  }
  async updateProfile(_ctx: RequestContext, _id: number, _v: number, _f: UserProfileFields) {
    return this.updateProfileResult;
  }
  async replaceRoles(_ctx: RequestContext, id: number, roleIds: number[]) {
    this.lastReplaceRoles = { id, roleIds };
    return userRow({ userId: id });
  }
  async updatePassword() { return true; }
  async softDelete() { return this.softDeleteResult; }
  async roleCatalog() { return []; }
}

function make(): { svc: UserService; repo: FakeRepo } {
  const repo = new FakeRepo();
  const svc = new UserService(repo as unknown as UserRepository);
  return { svc, repo };
}

describe('UserService.create', () => {
  const base = { username: 'jdoe', email: 'jdoe@be.test', fullName: 'Jane Doe', roleCodes: ['SALES'] };

  it('hashes the password and never persists it in plain text', async () => {
    const { svc, repo } = make();
    await svc.create(ctx(), { ...base, password: STRONG });
    const stored = repo.lastCreate!.data.passwordHash;
    expect(stored).not.toContain(STRONG);
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword(STRONG, stored)).toBe(true);
    expect(repo.lastCreate!.roleIds).toEqual([1]); // SALES resolved
  });

  it('rejects a weak password (400) via validatePasswordPolicy', async () => {
    const { svc } = make();
    await expect(svc.create(ctx(), { ...base, password: 'weak' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an unknown role code (400)', async () => {
    const { svc } = make();
    await expect(svc.create(ctx(), { ...base, password: STRONG, roleCodes: ['SALES', 'WIZARD'] }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('maps a duplicate username to 409', async () => {
    const { svc, repo } = make();
    repo.existingUsernames.add('jdoe');
    await expect(svc.create(ctx(), { ...base, password: STRONG }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('UserService self-lockout safeguards', () => {
  it('refuses to deactivate your own account (400)', async () => {
    const { svc, repo } = make();
    repo.byId.set(1, userRow({ userId: 1 }));
    await expect(svc.update(ctx(1), 1, { isActive: false, rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('allows deactivating a DIFFERENT user', async () => {
    const { svc, repo } = make();
    repo.byId.set(10, userRow({ userId: 10 }));
    repo.updateProfileResult = userRow({ userId: 10, isActive: false });
    const out = await svc.update(ctx(1), 10, { isActive: false, rowVersion: 1 });
    expect(out.isActive).toBe(false);
  });

  it('refuses to remove ADMIN from your own account (400)', async () => {
    const { svc, repo } = make();
    repo.byId.set(1, userRow({ userId: 1, roleCodes: ['ADMIN'] }));
    await expect(svc.assignRoles(ctx(1), 1, { roleCodes: ['SALES'] }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('allows reassigning your own roles as long as ADMIN is retained', async () => {
    const { svc, repo } = make();
    repo.byId.set(1, userRow({ userId: 1, roleCodes: ['ADMIN'] }));
    await svc.assignRoles(ctx(1), 1, { roleCodes: ['ADMIN', 'PLANNING'] });
    expect(repo.lastReplaceRoles!.roleIds.sort()).toEqual([2, 3]);
  });

  it('refuses to delete your own account (400)', async () => {
    const { svc } = make();
    await expect(svc.delete(ctx(1), 1, 1)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('UserService not-found + concurrency mapping', () => {
  it('404s an unknown user on getById', async () => {
    const { svc } = make();
    await expect(svc.getById(ctx(), 999)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('maps a row-version conflict on update to 409', async () => {
    const { svc, repo } = make();
    repo.byId.set(10, userRow({ userId: 10 }));
    repo.updateProfileResult = null; // simulate stale row_version
    await expect(svc.update(ctx(1), 10, { fullName: 'New Name', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('maps a row-version conflict on delete to 409', async () => {
    const { svc, repo } = make();
    repo.byId.set(10, userRow({ userId: 10 }));
    repo.softDeleteResult = false; // simulate stale row_version
    await expect(svc.delete(ctx(1), 10, 1)).rejects.toMatchObject({ statusCode: 409 });
  });
});
