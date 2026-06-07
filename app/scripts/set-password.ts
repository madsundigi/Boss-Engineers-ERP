import { Pool } from 'pg';
import { env } from '../src/config/env';
import { hashPassword, validatePasswordPolicy } from '../src/common/password';

/**
 * Set (or reset) an application user's password.
 *   ts-node scripts/set-password.ts <username> <password>
 * Uses the project's scrypt hasher and enforces the complexity policy. Connects
 * with DATABASE_URL (use an admin/owner URL — this writes sec.app_user).
 */
async function main(): Promise<void> {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    console.error('usage: ts-node scripts/set-password.ts <username> <password>');
    process.exit(2);
  }
  const violations = validatePasswordPolicy(password);
  if (violations.length) {
    console.error('Password does not meet policy:\n  - ' + violations.join('\n  - '));
    process.exit(1);
  }

  const pool = new Pool({ connectionString: env.databaseUrl });
  try {
    const res = await pool.query(
      `UPDATE sec.app_user SET password_hash = $1, updated_at = now()
        WHERE username = $2 AND NOT is_deleted
        RETURNING user_id`,
      [hashPassword(password), username],
    );
    if (res.rowCount === 0) {
      console.error(`No active user named "${username}".`);
      process.exit(1);
    }
    console.log(`Password updated for "${username}" (user_id=${res.rows[0].user_id}).`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
