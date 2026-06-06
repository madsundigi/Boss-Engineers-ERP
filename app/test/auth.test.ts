import { AuthService } from '../src/common/auth';

/* Unit tests for identity resolution — no DB needed for the fail-closed paths
 * (they throw in resolveIdentity, before any query). */

type Headers = Record<string, string>;
const fakeReq = (h: Headers) =>
  ({ header: (k: string) => h[k.toLowerCase()], ip: '127.0.0.1' }) as never;

const failPool = { query: jest.fn(() => { throw new Error('DB must not be queried'); }) } as never;

const status = (p: Promise<unknown>) => p.then(() => 0, (e: { statusCode?: number }) => e.statusCode);

describe('AuthService — fail-closed identity', () => {
  afterEach(() => { delete process.env.AUTH_JWT_SECRET; process.env.NODE_ENV = 'test'; });

  it('rejects header-only identity in production (401, fail closed)', async () => {
    process.env.NODE_ENV = 'production'; delete process.env.AUTH_JWT_SECRET;
    const svc = new AuthService(failPool);
    await expect(status(svc.resolve(fakeReq({ 'x-user-id': '1', 'x-company-id': '1' })))).resolves.toBe(401);
    expect((failPool as { query: jest.Mock }).query).not.toHaveBeenCalled();
  });

  it('requires a bearer token when AUTH_JWT_SECRET is set (no header fallback)', async () => {
    process.env.AUTH_JWT_SECRET = 'secret'; process.env.NODE_ENV = 'test';
    const svc = new AuthService(failPool);
    await expect(status(svc.resolve(fakeReq({ 'x-user-id': '1', 'x-company-id': '1' })))).resolves.toBe(401);
  });

  it('still accepts dev/test header identity when no secret configured', async () => {
    process.env.NODE_ENV = 'test'; delete process.env.AUTH_JWT_SECRET;
    const okPool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ username: 'u' }] }) // app_user lookup
        .mockResolvedValueOnce({ rows: [{ perm_code: 'ENQUIRY.VIEW' }] }), // permissions
    } as never;
    const ctx = await new AuthService(okPool).resolve(
      fakeReq({ 'x-user-id': '7', 'x-company-id': '3', 'x-bu-id': '2' }));
    expect(ctx.userId).toBe(7);
    expect(ctx.companyId).toBe(3);
    expect(ctx.buId).toBe(2);
    expect(ctx.permissions.has('ENQUIRY.VIEW')).toBe(true);
  });
});
