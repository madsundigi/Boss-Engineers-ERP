import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { hashPassword } from '../src/common/password';
import { authRouter } from '../src/modules/auth/auth.routes';

/**
 * Integration tests for the login/JWT issuance flow. Runs only when DATABASE_URL
 * is set. Sets AUTH_JWT_SECRET so the authenticate() middleware enforces the
 * verified-token path (no header fallback), exercising real end-to-end auth, and
 * restores the prior env in afterAll so sibling suites are unaffected.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter(pool));
  app.use('/api', authenticate(new AuthService(pool)));
  app.get('/api/me', (req, res) => {
    const ctx = req.context!;
    res.json({
      userId: ctx.userId, username: ctx.username,
      companyId: ctx.companyId, permissions: [...ctx.permissions],
    });
  });
  app.use(errorMiddleware);
  return app;
}

d('Auth login (integration) — password verify + JWT issuance + protected access', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let userId: number;
  const PASSWORD = 'Sup3r-Secret!Pass';
  const prevSecret = process.env.AUTH_JWT_SECRET;

  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'test-secret-for-login-suite';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    // Give a known seed user a real scrypt password to log in with.
    const u = await one(
      `UPDATE sec.app_user SET password_hash = $1 WHERE username = 'admin_user' RETURNING user_id`,
      [hashPassword(PASSWORD)]);
    userId = Number(u.user_id);
  });

  afterAll(async () => {
    if (prevSecret === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = prevSecret;
    await pool.end();
  });

  it('issues a Bearer token for valid credentials (200) and lists permissions', async () => {
    const res = await request(app).post('/auth/login')
      .send({ username: 'admin_user', password: PASSWORD, companyId });
    expect(res.status).toBe(200);
    expect(res.body.tokenType).toBe('Bearer');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.userId).toBe(userId);
    expect(res.body.user.companyId).toBe(companyId);
    expect(Array.isArray(res.body.permissions)).toBe(true);
  });

  it('rejects a wrong password (401) without leaking which field was wrong', async () => {
    const res = await request(app).post('/auth/login')
      .send({ username: 'admin_user', password: 'wrong', companyId });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown user (401)', async () => {
    const res = await request(app).post('/auth/login')
      .send({ username: 'nobody_here', password: PASSWORD, companyId });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body (400)', async () => {
    const res = await request(app).post('/auth/login').send({ username: 'admin_user' });
    expect(res.status).toBe(400);
  });

  it('the issued token authenticates a protected /api route (200)', async () => {
    const login = await request(app).post('/auth/login')
      .send({ username: 'admin_user', password: PASSWORD, companyId });
    const token = login.body.token as string;
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe(userId);
    expect(me.body.companyId).toBe(companyId);
  });

  it('rejects a protected route without a token (401) when a secret is configured', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });
});
