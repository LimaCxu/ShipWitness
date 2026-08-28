import { createHash } from 'node:crypto';
import { decryptSecret, encryptSecret, keyFromSecret } from './signing.js';

export function rotateEncryptedSecrets(data, oldSecret, newSecret) {
  keyFromSecret(oldSecret); keyFromSecret(newSecret);
  if (oldSecret === newSecret) throw new Error('新旧主密钥不能相同');
  const signingKeys = data.workspaces.filter(item => item.signingKey?.encryptedPrivateKey).map(item => ({ item, plaintext: decryptSecret(item.signingKey.encryptedPrivateKey, oldSecret) }));
  const webhookSecrets = data.webhooks.filter(item => item.encryptedSecret).map(item => ({ item, plaintext: decryptSecret(item.encryptedSecret, oldSecret) }));
  const emailMessages = (data.emailDeliveries || []).filter(item => item.encryptedMessage).map(item => ({ item, plaintext: decryptSecret(item.encryptedMessage, oldSecret) }));
  for (const { item, plaintext } of signingKeys) item.signingKey.encryptedPrivateKey = encryptSecret(plaintext, newSecret);
  for (const { item, plaintext } of webhookSecrets) item.encryptedSecret = encryptSecret(plaintext, newSecret);
  for (const { item, plaintext } of emailMessages) item.encryptedMessage = encryptSecret(plaintext, newSecret);
  return { workspaces: signingKeys.length, webhooks: webhookSecrets.length, emailDeliveries: emailMessages.length };
}

export function masterKeyFingerprint(secret) {
  return createHash('sha256').update(keyFromSecret(secret)).digest('hex').slice(0, 12);
}

export function assertRollbackImage(image, backupVersion) {
  const value = String(image || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error('回退镜像必须使用精确的 repository:version 标签');
  const tag = value.slice(value.lastIndexOf(':') + 1);
  if (tag === 'latest') throw new Error('禁止使用 latest 回退');
  if (!backupVersion || tag !== backupVersion) throw new Error(`回退镜像版本 ${tag} 与备份版本 ${backupVersion || '未知'} 不一致`);
  return value;
}

export function rollbackCommands({ image, backupFolder }) {
  return [
    ['docker', 'image', 'inspect', image],
    ['docker', 'compose', 'stop', 'shipwitness'],
    ['docker', 'compose', 'run', '--rm', '--no-deps', '-e', 'SHIPWITNESS_RESTORE_CONFIRM=YES', '-v', `${backupFolder}:/rollback-backup:ro`, 'shipwitness', 'npm', 'run', 'restore', '--', '/rollback-backup'],
    ['docker', 'compose', 'up', '-d', '--no-deps', 'shipwitness']
  ];
}
