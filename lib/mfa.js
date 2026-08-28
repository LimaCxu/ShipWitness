import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(buffer) {
  let bits = ''; for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = ''; for (let index = 0; index < bits.length; index += 5) output += alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  return output;
}

export function decodeBase32(value) {
  const input = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = ''; for (const character of input) { const index = alphabet.indexOf(character); if (index < 0) throw new Error('两步验证密钥无效'); bits += index.toString(2).padStart(5, '0'); }
  const bytes = []; for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export const createTotpSecret = () => encodeBase32(randomBytes(20));

export function totpCode(secret, time = Date.now(), stepSeconds = 30) {
  const counter = Math.floor(time / 1000 / stepSeconds); const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest(); const offset = digest[digest.length - 1] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, '0');
}

export function verifyTotp(code, secret, now = Date.now()) {
  const input = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(input)) return false;
  return [-1, 0, 1].some(offset => { const expected = Buffer.from(totpCode(secret, now + offset * 30_000)); const actual = Buffer.from(input); return expected.length === actual.length && timingSafeEqual(expected, actual); });
}

export const hashRecoveryCode = code => createHash('sha256').update(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
export const createRecoveryCodes = (count = 10) => Array.from({ length: count }, () => `${randomBytes(4).toString('hex').slice(0, 4)}-${randomBytes(4).toString('hex').slice(0, 4)}`.toUpperCase());

export function consumeMfaCode(user, code, secret, now = Date.now()) {
  if (verifyTotp(code, secret, now)) return { valid: true, method: 'totp' };
  const hash = hashRecoveryCode(code); const index = (user.mfaRecoveryCodeHashes || []).indexOf(hash);
  if (index < 0) return { valid: false };
  return { valid: true, method: 'recovery', recoveryIndex: index };
}
