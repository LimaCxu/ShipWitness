import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

function keyFromSecret(value) {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw Object.assign(new Error('SHIPWITNESS_MASTER_KEY 必须是 32 字节 Base64'), { status: 409 });
  return key;
}

export function encryptSecret(value, masterSecret) {
  const masterKey = keyFromSecret(masterSecret); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', masterKey, iv); const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]); const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(encoded, masterSecret) {
  const masterKey = keyFromSecret(masterSecret); const [version, iv, tag, encrypted] = String(encoded || '').split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw Object.assign(new Error('加密内容格式无效'), { status: 500 });
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'base64')); decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

export function canonicalJson(value) {
  const normalize = item => Array.isArray(item) ? item.map(normalize) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])])) : item;
  return JSON.stringify(normalize(value));
}

export function createSigningKey(masterSecret) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { algorithm: 'Ed25519', publicKey: publicKey.export({ type: 'spki', format: 'pem' }), encryptedPrivateKey: encryptSecret(privatePem, masterSecret) };
}

export function signPayload(payload, signingKey, masterSecret) {
  const value = sign(null, Buffer.from(canonicalJson(payload)), decryptSecret(signingKey.encryptedPrivateKey, masterSecret)).toString('base64');
  return { algorithm: 'Ed25519', publicKey: signingKey.publicKey, value };
}

export function verifySignedPayload(payload, signature) {
  if (signature?.algorithm !== 'Ed25519') return false;
  try { return verify(null, Buffer.from(canonicalJson(payload)), signature.publicKey, Buffer.from(signature.value, 'base64')); } catch { return false; }
}
