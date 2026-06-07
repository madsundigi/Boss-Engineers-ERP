import jwt from 'jsonwebtoken';

/**
 * JWT access-token verification (VULN-A1 remediation).
 *
 * Identity/tenant must be derived from a cryptographically verified token, not
 * from raw request headers. `verifyAccessToken` validates the signature with the
 * symmetric secret in `AUTH_JWT_SECRET` and extracts the claims we trust.
 *
 * Fails closed: returns null if the secret is unset, the signature is invalid,
 * the token is expired/malformed, or the required numeric claims are missing.
 */

export interface AccessTokenClaims {
  userId: number;
  companyId: number;
  buId?: number;
}

/** Default access-token lifetime; override with AUTH_JWT_TTL (e.g. '8h', '30m'). */
const DEFAULT_TTL = process.env.AUTH_JWT_TTL ?? '8h';

/**
 * Sign a short-lived access token from trusted identity claims. Throws if
 * AUTH_JWT_SECRET is not configured — token issuance must never silently
 * produce an unverifiable token. The login route is the only caller.
 */
export function signAccessToken(claims: AccessTokenClaims): { token: string; expiresIn: string } {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET is not configured');
  const payload: Record<string, number> = { userId: claims.userId, companyId: claims.companyId };
  if (claims.buId !== undefined) payload.buId = claims.buId;
  const token = jwt.sign(payload, secret, { expiresIn: DEFAULT_TTL } as jwt.SignOptions);
  return { token, expiresIn: DEFAULT_TTL };
}

/** Coerce a claim that may be a number or numeric string into a positive int. */
function toPositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * Verify and decode an access token. Returns the identity claims on success, or
 * null on any failure (no secret configured, bad signature, expired, malformed,
 * or missing/invalid required claims).
 */
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) return null;
  if (typeof token !== 'string' || token.length === 0) return null;

  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;

  const userId = toPositiveInt(payload.userId);
  const companyId = toPositiveInt(payload.companyId);
  if (userId === undefined || companyId === undefined) return null;

  const buId = toPositiveInt(payload.buId);

  const claims: AccessTokenClaims = { userId, companyId };
  if (buId !== undefined) claims.buId = buId;
  return claims;
}
