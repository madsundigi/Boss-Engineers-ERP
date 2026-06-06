import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Password hashing & policy helpers (VULN-P1 / VULN-A2).
 *
 * Uses Node's built-in scrypt (memory-hard KDF) so no external dependency is
 * required. Stored format is self-describing: `scrypt$<saltHex>$<hashHex>`,
 * which lets us evolve parameters later by branching on the algorithm tag.
 *
 * NOTE: argon2id is the auditor's preferred KDF; scrypt is the strongest option
 * available from the standard library and is an accepted NIST 800-63B verifier.
 */

const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

/** Hash a plaintext password, returning `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, KEY_LENGTH);
  return `${ALGORITHM}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored `scrypt$<saltHex>$<hashHex>`
 * value using a constant-time comparison. Returns false on any malformed input
 * rather than throwing, so callers cannot distinguish "bad format" from
 * "wrong password" via exceptions.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;

  const [algo, saltHex, hashHex] = parts;
  if (algo !== ALGORITHM || !saltHex || !hashHex) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = scryptSync(plain, salt, expected.length);
  // Lengths are equal by construction (derived to expected.length), but guard
  // anyway: timingSafeEqual throws if the buffers differ in length.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Validate a password against the baseline complexity policy. Returns a list of
 * human-readable violations; an empty array means the password is acceptable.
 *
 * Policy: min length 12, at least one uppercase, lowercase, digit, and symbol.
 */
export function validatePasswordPolicy(plain: string): string[] {
  const violations: string[] = [];
  if (typeof plain !== 'string' || plain.length < 12) {
    violations.push('Password must be at least 12 characters long');
  }
  if (!/[A-Z]/.test(plain)) {
    violations.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(plain)) {
    violations.push('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(plain)) {
    violations.push('Password must contain at least one digit');
  }
  if (!/[^A-Za-z0-9]/.test(plain)) {
    violations.push('Password must contain at least one symbol');
  }
  return violations;
}
