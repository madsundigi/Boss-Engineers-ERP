import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 6238 TOTP (and RFC 4226 HOTP) using only Node's crypto — no external
 * dependency, matching the project's password.ts (scrypt) approach. Secrets are
 * Base32 (the format authenticator apps expect via the otpauth:// URI).
 *
 * 6 digits, SHA-1, 30s step (the de-facto standard Google Authenticator uses).
 * verifyTotp accepts a ±window of steps to tolerate clock skew.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', secret).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16)
    | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (code % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** A fresh Base32 enrollment secret (default 20 random bytes -> 160 bits). */
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** The current TOTP code for a Base32 secret (t in ms, for testability). */
export function totpCode(secretB32: string, t: number = Date.now()): string {
  return hotp(base32Decode(secretB32), Math.floor(t / 1000 / STEP));
}

/** Verify a 6-digit token within ±window steps (default ±1 -> ~90s tolerance). */
export function verifyTotp(
  secretB32: string, token: string, t: number = Date.now(), window = 1,
): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(t / 1000 / STEP);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === token) return true;
  }
  return false;
}

/** otpauth:// URI for QR enrollment in an authenticator app. */
export function otpauthUrl(secretB32: string, account: string, issuer = 'Boss Engineers ERP'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&period=${STEP}&digits=${DIGITS}`;
}
