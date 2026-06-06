import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { Errors } from './http-error';
import { RequestContext } from './request-context';
import { asyncHandler } from './async-handler';
import { verifyAccessToken } from './jwt';

/**
 * AuthService resolves the RequestContext for a request.
 *
 * Identity/tenant resolution (VULN-A1): when an `Authorization: Bearer <token>`
 * header is present AND `AUTH_JWT_SECRET` is configured, identity (user, company,
 * business unit) is derived from the cryptographically verified JWT — never from
 * raw, spoofable headers. If verification fails, the request is rejected 401.
 *
 * When no bearer token / secret is configured (dev/test), we fall back to the
 * legacy `x-user-id`/`x-company-id`/`x-bu-id` headers. Either way, the user's
 * effective permissions are always loaded server-side from the RBAC tables.
 */
export class AuthService {
  constructor(private readonly pool: Pool) {}

  /**
   * Derive (userId, companyId, buId) for a request. Prefers a verified JWT;
   * otherwise falls back to the dev identity headers (unchanged behavior).
   */
  private resolveIdentity(req: Request): {
    userId: number;
    companyId: number;
    buId: number | null;
  } {
    const bearer = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const secret = process.env.AUTH_JWT_SECRET;

    // When a JWT secret is configured, a verified token is REQUIRED — never fall
    // back to spoofable identity headers (closes the fail-open hole, BUG-02).
    if (secret) {
      if (!bearer) throw Errors.unauthorized('Bearer token required');
      const claims = verifyAccessToken(bearer);
      if (!claims) throw Errors.unauthorized('Invalid or expired token');
      return {
        userId: claims.userId,
        companyId: claims.companyId,
        buId: claims.buId ?? null,
      };
    }

    // No secret configured: FAIL CLOSED in production — the x-user-id header
    // fallback exists only for local dev/test, never for a real deployment.
    if (process.env.NODE_ENV === 'production') {
      throw Errors.unauthorized('Authentication is not configured (AUTH_JWT_SECRET required in production)');
    }

    const userId = Number(req.header('x-user-id'));
    const companyId = Number(req.header('x-company-id'));
    if (!Number.isInteger(userId) || userId <= 0) throw Errors.unauthorized('Missing x-user-id');
    if (!Number.isInteger(companyId) || companyId <= 0) throw Errors.unauthorized('Missing x-company-id');

    const buHeader = req.header('x-bu-id');
    const headerBuId = buHeader ? Number(buHeader) : null;
    return {
      userId,
      companyId,
      buId: headerBuId && Number.isInteger(headerBuId) ? headerBuId : null,
    };
  }

  async resolve(req: Request): Promise<RequestContext> {
    const { userId, companyId, buId } = this.resolveIdentity(req);

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
      buId,
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
