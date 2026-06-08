import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { hashPassword } from '../src/common/password';
import { totpCode } from '../src/common/totp';
import { authRouter } from '../src/modules/auth/auth.routes';
import { mfaRouter } from '../src/modules/auth/mfa.routes';

/**
 * MFA (TOTP) enrollment + login enforcement. Runs only when DATABASE_URL is set.
 * Sets AUTH_JWT_SECRET so the verified-token path is active and restores it after.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter(pool));
  app.use('/api', authenticate(new AuthService(pool)));
  app.use('/api/auth', mfaRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('MFA (TOTP) — enrollment then enforced at login', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  const PASSWORD = 'Mfa-Test!Pass99';
  const prevSecret = process.env.AUTH_JWT_SECRET;

  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = 'mfa-suite-secret';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows[0];
    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    await pool.query(
      `UPDATE sec.app_user SET password_hash=$1, mfa_enabled=false, mfa_secret=NULL WHERE username='hr_user'`,
      [hashPassword(PASSWORD)]);
  });

  afterAll(async () => {
    if (prevSecret === undefined) delete process.env.AUTH_JWT_SECRET;
    else process.env.AUTH_JWT_SECRET = prevSecret;
    await pool.end();
  });

  const login = (extra: Record<string, unknown> = {}) =>
    request(app).post('/auth/login').send({ username: 'hr_user', password: PASSWORD, companyId, ...extra });

  it('enrolls TOTP then requires a code on subsequent logins', async () => {
    // 1. password-only login works before MFA is enabled
    const first = await login();
    expect(first.status).toBe(200);
    const token = first.body.token as string;

    // 2. enroll: setup -> enable with a generated code
    const setup = await request(app).post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    expect(secret).toBeTruthy();

    const enable = await request(app).post('/api/auth/mfa/enable')
      .set('Authorization', `Bearer ${token}`).send({ token: totpCode(secret) });
    expect(enable.status).toBe(200);

    // 3. password alone is now rejected; a valid code is required
    expect((await login()).status).toBe(401);
    expect((await login({ totp: '000000' })).status).toBe(401);
    const ok = await login({ totp: totpCode(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.tokenType).toBe('Bearer');
  });
});
