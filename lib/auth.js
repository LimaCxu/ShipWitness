import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw Object.assign(new Error('密码至少需要 10 个字符'), { status: 400 });
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedHex] = String(encoded || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = await scrypt(String(password || ''), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const createSessionToken = () => randomBytes(32).toString('base64url');

export const sessionCookie = (token, { secure = false, maxAge = 60 * 60 * 24 * 7 } = {}) =>
  `shipwitness_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

export const clearSessionCookie = secure => `shipwitness_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;

export function readSessionToken(cookieHeader) {
  const match = String(cookieHeader || '').split(';').map(item => item.trim()).find(item => item.startsWith('shipwitness_session='));
  return match ? decodeURIComponent(match.slice('shipwitness_session='.length)) : null;
}
