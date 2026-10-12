import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 32;

function scryptAsync(secret: string, salt: Buffer, n = SCRYPT_N): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret, salt, KEYLEN, { N: n, r: SCRYPT_r, p: SCRYPT_p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(secret, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Spend comparable time so missing accounts are not distinguishable by latency.
    await scryptAsync(secret, randomBytes(16));
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const key = await scryptAsync(secret, Buffer.from(parts[4], 'base64'), Number(parts[1]));
  const expected = Buffer.from(parts[5], 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Opaque bearer token (URL-safe) and the hash we persist. */
export function newToken(bytes = 32): { token: string; hash: Buffer } {
  const token = randomBytes(bytes).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Human-friendly pairing code, e.g. "K7Q-4MX-29P" (no ambiguous characters). */
export function newPairingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 9; i++) {
    if (i > 0 && i % 3 === 0) out += '-';
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

export function normalizePairingCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.replace(/(.{3})(?=.)/g, '$1-');
}

// ---------------------------------------------------------------------------
// Face template encryption (AES-256-GCM, per-record random IV, versioned keys)
// ---------------------------------------------------------------------------
export interface EncryptedBlob {
  keyVersion: number;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export class TemplateCipher {
  constructor(
    private readonly keys: Map<number, Buffer>,
    private readonly currentVersion: number,
  ) {}

  encrypt(plain: Buffer, aad: string): EncryptedBlob {
    const key = this.keys.get(this.currentVersion);
    if (!key) throw new Error('current template key missing');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { keyVersion: this.currentVersion, iv, ciphertext, authTag: cipher.getAuthTag() };
  }

  /** aad binds the ciphertext to its employee so rows cannot be swapped between employees. */
  decrypt(blob: EncryptedBlob, aad: string): Buffer {
    const key = this.keys.get(blob.keyVersion);
    if (!key) throw new Error(`template key version ${blob.keyVersion} not configured`);
    const decipher = createDecipheriv('aes-256-gcm', key, blob.iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(blob.authTag);
    return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
  }
}
