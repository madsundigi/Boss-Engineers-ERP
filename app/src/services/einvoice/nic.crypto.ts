import {
  createCipheriv, createDecipheriv, publicEncrypt, randomBytes,
  constants as cryptoConstants,
} from 'node:crypto';

/**
 * NIC IRP cryptographic envelope helpers (node:crypto only — no dependencies).
 *
 * The NIC e-Invoice / e-Way Bill APIs use a hybrid scheme:
 *   1. The client generates a random 256-bit symmetric **AppKey**.
 *   2. The auth request payload (username/password/AppKey...) is AES-256-ECB
 *      encrypted with the AppKey, base64-encoded, and posted to /auth.
 *   3. The AppKey itself is RSA-encrypted (PKCS#1 v1.5) with NIC's public
 *      certificate and sent alongside, so only NIC can recover it.
 *   4. NIC's auth response returns an encrypted session key **Sek** (AES-ECB
 *      encrypted with the AppKey). The client decrypts Sek with the AppKey.
 *   5. Every subsequent API call AES-256-ECB encrypts its JSON payload with the
 *      Sek (base64), and decrypts the base64 response Data with the Sek.
 *
 * AES-256-ECB is what the NIC sandbox specifies; we implement exactly that.
 * These helpers are pure and individually unit-tested (round-trip) without any
 * network or live NIC certificate.
 */

/** Generate a fresh 32-byte (256-bit) symmetric key, returned as a Buffer. */
export function generateAppKey(): Buffer {
  return randomBytes(32);
}

/**
 * AES-256-ECB encrypt a UTF-8 string with a 32-byte key; returns base64.
 * ECB has no IV (hence `null`); PKCS#7 padding is applied by default.
 */
export function aesEncrypt(plaintext: string, key: Buffer): string {
  assertKey(key);
  const cipher = createCipheriv('aes-256-ecb', key, null);
  return Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
    .toString('base64');
}

/** AES-256-ECB decrypt a base64 ciphertext with a 32-byte key; returns UTF-8. */
export function aesDecrypt(base64Cipher: string, key: Buffer): string {
  assertKey(key);
  const decipher = createDecipheriv('aes-256-ecb', key, null);
  return Buffer.concat([
    decipher.update(Buffer.from(base64Cipher, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * RSA-encrypt a buffer (the AppKey) with NIC's public certificate, returning
 * base64. NIC's documented padding is PKCS#1 v1.5. `publicKeyPem` must be a PEM
 * SPKI/cert block (`-----BEGIN PUBLIC KEY-----` or `-----BEGIN CERTIFICATE-----`).
 */
export function rsaEncrypt(data: Buffer, publicKeyPem: string): string {
  return publicEncrypt(
    { key: publicKeyPem, padding: cryptoConstants.RSA_PKCS1_PADDING },
    data,
  ).toString('base64');
}

/**
 * Decrypt the session key (Sek) returned by the NIC auth response. NIC returns
 * `Sek` AES-256-ECB encrypted with the AppKey; we recover the raw Sek bytes.
 */
export function decryptSek(encryptedSekBase64: string, appKey: Buffer): Buffer {
  assertKey(appKey);
  const decipher = createDecipheriv('aes-256-ecb', appKey, null);
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedSekBase64, 'base64')),
    decipher.final(),
  ]);
}

/**
 * Normalise the configured NIC public key into PEM. Accepts either a ready PEM
 * block (returned as-is) or a bare base64 DER body (wrapped as a PUBLIC KEY PEM).
 */
export function toPublicKeyPem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? trimmed;
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error(`AES-256 key must be 32 bytes (got ${Buffer.isBuffer(key) ? key.length : typeof key})`);
  }
}
