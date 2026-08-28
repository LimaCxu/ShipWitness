import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw Object.assign(new Error('密码至少需要 10 个字符'), { status: 400 });
  if (password.length > 128) throw Object.assign(new Error('密码不能超过 128 个字符'), { status: 400 });
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128) throw Object.assign(new Error('密码不能超过 128 个字符'), { status: 400 });
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

export function createLoginThrottle({ maxAttempts = 5, windowMs = 15 * 60_000, maxEntries = 10_000, now = Date.now } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(windowMs) || windowMs < 1 || !Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('登录限流配置无效');
  const attempts = new Map();
  const active = (key, at) => {
    const entry = attempts.get(key);
    if (entry && at - entry.startedAt >= windowMs) { attempts.delete(key); return null; }
    return entry || null;
  };
  const sweep = at => {
    for (const [key, entry] of attempts) if (at - entry.startedAt >= windowMs) attempts.delete(key);
    while (attempts.size >= maxEntries) attempts.delete(attempts.keys().next().value);
  };
  const state = key => {
    const at = now(); const entry = active(String(key), at);
    const blocked = Boolean(entry && entry.count >= maxAttempts);
    return { blocked, retryAfterSeconds: blocked ? Math.max(1, Math.ceil((entry.startedAt + windowMs - at) / 1000)) : 0 };
  };
  return {
    check: state,
    recordFailure(key) {
      const normalized = String(key); const at = now(); let entry = active(normalized, at);
      if (!entry) { sweep(at); entry = { count: 0, startedAt: at }; attempts.set(normalized, entry); }
      entry.count += 1;
      return state(normalized);
    },
    clear(key) { attempts.delete(String(key)); },
    get size() { return attempts.size; }
  };
}
