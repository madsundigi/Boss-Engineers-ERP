import { Pool } from 'pg';
import { Errors } from '../../common/http-error';
import { verifyPassword } from '../../common/password';
import { verifyTotp } from '../../common/totp';
import { signAccessToken } from '../../common/jwt';
import { LoginDto } from './auth.dto';

export interface LoginResult {
  token: string;
  tokenType: 'Bearer';
  expiresIn: string;
  user: {
    userId: number;
    username: string;
    fullName: string;
    email: string;
    companyId: number;
    buId: number | null;
  };
  permissions: string[];
}

/**
 * LoginService — verifies credentials and issues a signed access token.
 *
 * Identity flow: username+password -> verify scrypt hash -> resolve the tenant
 * (companyId from the request, else from the user's employee record) -> issue a
 * JWT carrying {userId, companyId, buId}. The authenticate() middleware then
 * trusts ONLY that verified token (never raw headers) when AUTH_JWT_SECRET is
 * set. Failures return a single generic 401 to avoid username enumeration.
 */
export class LoginService {
  constructor(private readonly pool: Pool) {}

  async login(dto: LoginDto): Promise<LoginResult> {
    const invalid = () => Errors.unauthorized('Invalid username or password');

    const userRes = await this.pool.query<{
      user_id: string; username: string; full_name: string; email: string;
      password_hash: string; employee_id: string | null; is_active: boolean;
      mfa_enabled: boolean; mfa_secret: string | null;
    }>(
      `SELECT user_id, username, full_name, email, password_hash, employee_id, is_active,
              mfa_enabled, mfa_secret
         FROM sec.app_user
        WHERE username = $1 AND NOT is_deleted`,
      [dto.username],
    );
    if (userRes.rowCount === 0) throw invalid();
    const u = userRes.rows[0];
    if (!u.is_active) throw invalid();
    if (!verifyPassword(dto.password, u.password_hash)) throw invalid();

    // Second factor: when the account has MFA enabled, a valid TOTP is required.
    if (u.mfa_enabled) {
      if (!dto.totp || !u.mfa_secret || !verifyTotp(u.mfa_secret, dto.totp)) {
        throw Errors.unauthorized('A valid MFA code is required');
      }
    }

    // Resolve the tenant: explicit companyId wins; otherwise derive it from the
    // user's linked employee. A user with neither cannot be scoped -> 400.
    let companyId = dto.companyId ?? null;
    if (companyId == null && u.employee_id != null) {
      const emp = await this.pool.query<{ company_id: string }>(
        'SELECT company_id FROM hcm.employee WHERE employee_id = $1', [u.employee_id]);
      companyId = emp.rowCount ? Number(emp.rows[0].company_id) : null;
    }
    if (companyId == null) {
      throw Errors.badRequest('companyId is required (user is not linked to a company)');
    }
    const co = await this.pool.query('SELECT 1 FROM mdm.company WHERE company_id = $1', [companyId]);
    if (co.rowCount === 0) throw Errors.badRequest('Unknown company');

    // Optional business unit (document-numbering scope), validated against the company.
    let buId = dto.buId ?? null;
    if (buId != null) {
      const bu = await this.pool.query(
        'SELECT 1 FROM mdm.business_unit WHERE bu_id = $1 AND company_id = $2', [buId, companyId]);
      if (bu.rowCount === 0) throw Errors.badRequest('Business unit does not belong to the company');
    }

    const permRes = await this.pool.query<{ perm_code: string }>(
      `SELECT DISTINCT p.perm_code
         FROM sec.user_role ur
         JOIN sec.role_permission rp ON rp.role_id = ur.role_id
         JOIN sec.permission p       ON p.permission_id = rp.permission_id
        WHERE ur.user_id = $1`,
      [u.user_id],
    );

    const { token, expiresIn } = signAccessToken({
      userId: Number(u.user_id), companyId, buId: buId ?? undefined,
    });

    await this.pool.query(
      'UPDATE sec.app_user SET last_login_at = now() WHERE user_id = $1', [u.user_id]);

    return {
      token, tokenType: 'Bearer', expiresIn,
      user: {
        userId: Number(u.user_id), username: u.username, fullName: u.full_name,
        email: u.email, companyId, buId,
      },
      permissions: permRes.rows.map((r) => r.perm_code),
    };
  }
}
