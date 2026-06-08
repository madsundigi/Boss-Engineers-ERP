import { generateSecret, totpCode, verifyTotp, otpauthUrl } from '../src/common/totp';

/** Unit tests for the RFC 6238 TOTP helper (no DB, no network). */
describe('TOTP helper', () => {
  it('generates a Base32 secret', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(s.length).toBeGreaterThanOrEqual(16);
  });

  it('produces a 6-digit code, stable within a 30s step', () => {
    const s = generateSecret();
    const t = 1_700_000_000_000; // fixed instant
    const code = totpCode(s, t);
    expect(code).toMatch(/^\d{6}$/);
    expect(totpCode(s, t + 1000)).toBe(code); // same 30s window
  });

  it('verifies the current code and rejects a wrong one', () => {
    const s = generateSecret();
    const t = 1_700_000_000_000;
    expect(verifyTotp(s, totpCode(s, t), t)).toBe(true);
    expect(verifyTotp(s, '000001', t)).toBe(false);
    expect(verifyTotp(s, 'abcdef', t)).toBe(false);
  });

  it('tolerates ±1 step of clock skew but not beyond the window', () => {
    const s = generateSecret();
    const t = 1_700_000_000_000;
    const prevStep = totpCode(s, t - 30_000);
    expect(verifyTotp(s, prevStep, t, 1)).toBe(true);   // within window
    expect(verifyTotp(s, prevStep, t, 0)).toBe(false);  // window disabled
    expect(verifyTotp(s, totpCode(s, t - 120_000), t, 1)).toBe(false); // far past
  });

  it('builds an otpauth:// enrollment URI', () => {
    const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'alice');
    expect(url).toContain('otpauth://totp/');
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=');
  });
});
