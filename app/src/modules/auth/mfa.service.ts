import { Pool } from 'pg';
import { Errors } from '../../common/http-error';
import { generateSecret, otpauthUrl, verifyTotp } from '../../common/totp';

/**
 * MfaService — TOTP enrollment for the authenticated user. setup() stores a fresh
 * secret (MFA not yet active); enable() verifies a code from the user's app and
 * flips mfa_enabled on; disable() turns it off after a final code. The login flow
 * (LoginService) then requires a valid code whenever mfa_enabled is true.
 */
export class MfaService {
  constructor(private readonly pool: Pool) {}

  async setup(userId: number): Promise<{ secret: string; otpauthUrl: string }> {
    const u = await this.pool.query<{ username: string }>(
      'SELECT username FROM sec.app_user WHERE user_id = $1 AND is_active', [userId]);
    if (u.rowCount === 0) throw Errors.unauthorized('Unknown user');
    const secret = generateSecret();
    await this.pool.query(
      'UPDATE sec.app_user SET mfa_secret = $1 WHERE user_id = $2', [secret, userId]);
    return { secret, otpauthUrl: otpauthUrl(secret, u.rows[0].username) };
  }

  async enable(userId: number, token: string): Promise<void> {
    const r = await this.pool.query<{ mfa_secret: string | null }>(
      'SELECT mfa_secret FROM sec.app_user WHERE user_id = $1 AND is_active', [userId]);
    const secret = r.rows[0]?.mfa_secret;
    if (!secret) throw Errors.badRequest('Run MFA setup first');
    if (!verifyTotp(secret, token)) throw Errors.badRequest('Invalid authenticator code');
    await this.pool.query(
      'UPDATE sec.app_user SET mfa_enabled = true WHERE user_id = $1', [userId]);
  }

  async disable(userId: number, token: string): Promise<void> {
    const r = await this.pool.query<{ mfa_secret: string | null }>(
      'SELECT mfa_secret FROM sec.app_user WHERE user_id = $1 AND is_active', [userId]);
    const secret = r.rows[0]?.mfa_secret;
    if (!secret || !verifyTotp(secret, token)) throw Errors.badRequest('Invalid authenticator code');
    await this.pool.query(
      'UPDATE sec.app_user SET mfa_enabled = false, mfa_secret = NULL WHERE user_id = $1', [userId]);
  }
}
