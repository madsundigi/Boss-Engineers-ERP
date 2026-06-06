import jwt from 'jsonwebtoken';
import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
} from '../src/common/password';
import { verifyAccessToken } from '../src/common/jwt';

describe('password.hashPassword / verifyPassword', () => {
  it('produces a self-describing scrypt$salt$hash string', () => {
    const stored = hashPassword('Sup3rSecret!Pass');
    const parts = stored.split('$');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toMatch(/^[0-9a-f]+$/i); // salt hex
    expect(parts[2]).toMatch(/^[0-9a-f]+$/i); // hash hex
  });

  it('uses a random salt so two hashes of the same password differ', () => {
    const a = hashPassword('Sup3rSecret!Pass');
    const b = hashPassword('Sup3rSecret!Pass');
    expect(a).not.toEqual(b);
  });

  it('round-trips: the original password verifies against its hash', () => {
    const stored = hashPassword('Sup3rSecret!Pass');
    expect(verifyPassword('Sup3rSecret!Pass', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('Sup3rSecret!Pass');
    expect(verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('returns false for malformed stored values instead of throwing', () => {
    expect(verifyPassword('whatever', '')).toBe(false);
    expect(verifyPassword('whatever', 'not-a-valid-format')).toBe(false);
    expect(verifyPassword('whatever', 'bcrypt$abc$def')).toBe(false);
    expect(verifyPassword('whatever', 'scrypt$$')).toBe(false);
  });
});

describe('password.validatePasswordPolicy', () => {
  it('accepts a compliant password (no violations)', () => {
    expect(validatePasswordPolicy('Sup3rSecret!Pass')).toEqual([]);
  });

  it('flags a too-short password', () => {
    const violations = validatePasswordPolicy('Ab1!');
    expect(violations.some((v) => /12 characters/i.test(v))).toBe(true);
  });

  it('flags a password missing an uppercase letter', () => {
    const violations = validatePasswordPolicy('sup3rsecret!pass');
    expect(violations.some((v) => /uppercase/i.test(v))).toBe(true);
  });

  it('flags a password missing a lowercase letter', () => {
    const violations = validatePasswordPolicy('SUP3RSECRET!PASS');
    expect(violations.some((v) => /lowercase/i.test(v))).toBe(true);
  });

  it('flags a password missing a digit', () => {
    const violations = validatePasswordPolicy('SuperSecret!Pass');
    expect(violations.some((v) => /digit/i.test(v))).toBe(true);
  });

  it('flags a password missing a symbol', () => {
    const violations = validatePasswordPolicy('Sup3rSecretPass1');
    expect(violations.some((v) => /symbol/i.test(v))).toBe(true);
  });

  it('reports multiple violations for a very weak password', () => {
    const violations = validatePasswordPolicy('abc');
    // too short + no upper + no digit + no symbol => at least 4
    expect(violations.length).toBeGreaterThanOrEqual(4);
  });
});

describe('jwt.verifyAccessToken', () => {
  const ORIGINAL_SECRET = process.env.AUTH_JWT_SECRET;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.AUTH_JWT_SECRET;
    } else {
      process.env.AUTH_JWT_SECRET = ORIGINAL_SECRET;
    }
  });

  it('returns null when AUTH_JWT_SECRET is unset', () => {
    delete process.env.AUTH_JWT_SECRET;
    const token = jwt.sign({ userId: 1, companyId: 1 }, 'some-secret');
    expect(verifyAccessToken(token)).toBeNull();
  });

  it('returns null for an empty token even when a secret is set', () => {
    process.env.AUTH_JWT_SECRET = 'test-secret';
    expect(verifyAccessToken('')).toBeNull();
  });

  it('returns null for a token signed with a different secret', () => {
    process.env.AUTH_JWT_SECRET = 'test-secret';
    const token = jwt.sign({ userId: 1, companyId: 1 }, 'WRONG-secret');
    expect(verifyAccessToken(token)).toBeNull();
  });

  it('returns null for a malformed (non-JWT) token', () => {
    process.env.AUTH_JWT_SECRET = 'test-secret';
    expect(verifyAccessToken('not.a.jwt')).toBeNull();
  });

  it('returns the claims for a valid token', () => {
    process.env.AUTH_JWT_SECRET = 'test-secret';
    const token = jwt.sign(
      { userId: 7, companyId: 3, buId: 5 },
      'test-secret',
    );
    expect(verifyAccessToken(token)).toEqual({ userId: 7, companyId: 3, buId: 5 });
  });

  it('omits buId when not present in the token', () => {
    process.env.AUTH_JWT_SECRET = 'test-secret';
    const token = jwt.sign({ userId: 7, companyId: 3 }, 'test-secret');
    expect(verifyAccessToken(token)).toEqual({ userId: 7, companyId: 3 });
  });

  it('returns null when required numeric claims are missing', () => {
    process.env.AUTH_JWT_SECRET = 'test-secret';
    const token = jwt.sign({ companyId: 3 }, 'test-secret'); // no userId
    expect(verifyAccessToken(token)).toBeNull();
  });
});
