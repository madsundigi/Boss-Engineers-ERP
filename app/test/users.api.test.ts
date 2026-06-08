import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { usersRouter, rolesRouter } from '../src/modules/users/users.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) for User & Role
 * Administration. Runs only when DATABASE_URL is set (provisioned by the test
 * harness) so the suite is a no-op without a database.
 *
 * Both module routers are mounted exactly as the composition root wires them:
 * usersRouter at /api/users and rolesRouter at /api/roles. admin_user already
 * holds the ADMIN role in the seed (USER_MGMT.* + ROLE_MGMT.*); sales_user holds
 * SALES only (no USER_MGMT) so it is used to assert the RBAC denials.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/users', usersRouter(pool));
  app.use('/api/roles', rolesRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('User & Role Administration API (integration) — CRUD, roles, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let adminUser: number;
  let salesUser: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  // Unique username per run so reruns against a persistent DB do not collide.
  const newUsername = `qa_user_${Date.now()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    adminUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='admin_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => {
    // Best-effort cleanup of the user this suite created.
    await pool.query(`DELETE FROM sec.app_user WHERE username = $1`, [newUsername]).catch(() => undefined);
    await pool.end();
  });

  let createdId: number;
  let createdVersion: number;

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('creates a user with roleCodes [SALES] (201) and never returns the hash', async () => {
    const res = await request(app).post('/api/users').set(hdr(adminUser)).send({
      username: newUsername,
      email: `${newUsername}@be.test`,
      fullName: 'QA Created User',
      password: 'Test#User1234',
      roleCodes: ['SALES'],
    });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe(newUsername);
    expect(res.body.roleCodes).toEqual(['SALES']);
    expect(res.body.isActive).toBe(true);
    expect(res.body).not.toHaveProperty('passwordHash');
    expect(res.body).not.toHaveProperty('password_hash');
    createdId = res.body.userId;
    createdVersion = res.body.rowVersion;
  });

  it('rejects a weak password (400)', async () => {
    const res = await request(app).post('/api/users').set(hdr(adminUser)).send({
      username: `${newUsername}_weak`,
      email: `weak_${newUsername}@be.test`,
      fullName: 'Weak Pw',
      password: 'short',
      roleCodes: ['SALES'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate username (409)', async () => {
    const res = await request(app).post('/api/users').set(hdr(adminUser)).send({
      username: newUsername, // already created above
      email: `dup_${newUsername}@be.test`,
      fullName: 'Dup User',
      password: 'Test#User1234',
      roleCodes: ['SALES'],
    });
    expect(res.status).toBe(409);
  });

  it('lists users (200) and includes the created user with its roleCodes', async () => {
    const res = await request(app).get(`/api/users?q=${newUsername}`).set(hdr(adminUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const found = res.body.rows.find((u: { username: string }) => u.username === newUsername);
    expect(found).toBeTruthy();
    expect(found.roleCodes).toEqual(['SALES']);
  });

  it('fetches one (200) and 404s an unknown id', async () => {
    const ok = await request(app).get(`/api/users/${createdId}`).set(hdr(adminUser));
    expect(ok.status).toBe(200);
    expect(ok.body.userId).toBe(createdId);
    const no = await request(app).get('/api/users/99999999').set(hdr(adminUser));
    expect(no.status).toBe(404);
  });

  it('replaces the roles via PUT to [SALES, PLANNING] (200)', async () => {
    const res = await request(app).put(`/api/users/${createdId}/roles`).set(hdr(adminUser))
      .send({ roleCodes: ['SALES', 'PLANNING'] });
    expect(res.status).toBe(200);
    expect([...res.body.roleCodes].sort()).toEqual(['PLANNING', 'SALES']);
    createdVersion = res.body.rowVersion;
  });

  it('resets the user password (204)', async () => {
    const res = await request(app).post(`/api/users/${createdId}/password`).set(hdr(adminUser))
      .send({ password: 'Reset#Pass5678' });
    expect(res.status).toBe(204);
  });

  it('GET /api/roles returns the 12-role catalog, each with a permissions array', async () => {
    const res = await request(app).get('/api/roles').set(hdr(adminUser));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(12);
    for (const role of res.body) {
      expect(typeof role.roleCode).toBe('string');
      expect(Array.isArray(role.permissions)).toBe(true);
    }
    const admin = res.body.find((r: { roleCode: string }) => r.roleCode === 'ADMIN');
    expect(admin.permissions).toContain('USER_MGMT.CREATE');
  });

  it('denies user create to a role without USER_MGMT (sales -> 403)', async () => {
    const res = await request(app).post('/api/users').set(hdr(salesUser)).send({
      username: `${newUsername}_x`,
      email: `x_${newUsername}@be.test`,
      fullName: 'No Perm',
      password: 'Test#User1234',
      roleCodes: ['SALES'],
    });
    expect(res.status).toBe(403);
  });

  it('denies user list to a role without USER_MGMT (sales -> 403)', async () => {
    const res = await request(app).get('/api/users').set(hdr(salesUser));
    expect(res.status).toBe(403);
  });
});
