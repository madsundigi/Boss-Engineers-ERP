import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { Errors } from './http-error';
import { RequestContext } from './request-context';
import { asyncHandler } from './async-handler';

/**
 * AuthService resolves the RequestContext for a request. In production the API
 * gateway verifies a JWT and injects identity/tenant; here (dev/test) we read
 * them from headers and load the user's effective permissions from the RBAC
 * tables. Permission resolution is always server-side from the database.
 */
export class AuthService {
  constructor(private readonly pool: Pool) {}

  async resolve(req: Request): Promise<RequestContext> {
    const userId = Number(req.header('x-user-id'));
    const companyId = Number(req.header('x-company-id'));
    if (!Number.isInteger(userId) || userId <= 0) throw Errors.unauthorized('Missing x-user-id');
    if (!Number.isInteger(companyId) || companyId <= 0) throw Errors.unauthorized('Missing x-company-id');

    const buHeader = req.header('x-bu-id');
    const buId = buHeader ? Number(buHeader) : null;

    const userRes = await this.pool.query<{ username: string }>(
      'SELECT username FROM sec.app_user WHERE user_id = $1 AND is_active',
      [userId],
    );
    if (userRes.rowCount === 0) throw Errors.unauthorized('Unknown or inactive user');

    const permRes = await this.pool.query<{ perm_code: string }>(
      `SELECT DISTINCT p.perm_code
         FROM sec.user_role ur
         JOIN sec.role_permission rp ON rp.role_id = ur.role_id
         JOIN sec.permission p       ON p.permission_id = rp.permission_id
        WHERE ur.user_id = $1`,
      [userId],
    );

    return {
      userId,
      username: userRes.rows[0].username,
      companyId,
      buId: buId && Number.isInteger(buId) ? buId : null,
      clientIp: req.ip ?? '0.0.0.0',
      sessionId: req.header('x-session-id') ?? `req-${Date.now()}`,
      permissions: new Set(permRes.rows.map((r) => r.perm_code)),
    };
  }
}

/** Express middleware: attach req.context or fail 401. */
export function authenticate(auth: AuthService) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    req.context = await auth.resolve(req);
    next();
  });
}
