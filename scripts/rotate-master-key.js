import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { appendAudit } from '../lib/audit.js';
import { masterKeyFingerprint, rotateEncryptedSecrets } from '../lib/operations.js';
import { PostgresStore } from '../lib/postgres-store.js';

const backupFolder = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;
const oldSecret = process.env.SHIPWITNESS_MASTER_KEY;
const newSecret = process.env.SHIPWITNESS_NEW_MASTER_KEY;
const fail = message => { console.error(JSON.stringify({ ok: false, error: message })); process.exit(1); };
if (process.env.SHIPWITNESS_KEY_ROTATION_CONFIRM !== 'YES') fail('轮换会修改所有加密材料；确认备份后设置 SHIPWITNESS_KEY_ROTATION_CONFIRM=YES');
if (!backupFolder || !databaseUrl || !oldSecret || !newSecret) fail('用法：提供 DATABASE_URL、SHIPWITNESS_MASTER_KEY、SHIPWITNESS_NEW_MASTER_KEY 和备份目录');
const manifest = JSON.parse(await readFile(join(resolve(backupFolder), 'manifest.json'), 'utf8'));
const ageHours = (Date.now() - new Date(manifest.createdAt).getTime()) / 3_600_000;
if (!Number.isFinite(ageHours) || ageHours < -0.1 || ageHours > 24) fail('密钥轮换要求 24 小时内创建的有效备份');
const verifyExit = await new Promise((resolveExit, reject) => { const child = spawn(process.execPath, [new URL('./verify-backup.js', import.meta.url).pathname, resolve(backupFolder)], { stdio: 'inherit' }); child.on('error', reject); child.on('exit', resolveExit); });
if (verifyExit !== 0) fail('备份校验失败，拒绝轮换');

const store = new PostgresStore(databaseUrl);
try {
  const rotated = await store.update(data => {
    const counts = rotateEncryptedSecrets(data, oldSecret, newSecret); const at = new Date().toISOString();
    for (const workspace of data.workspaces) appendAudit(data, { workspaceId: workspace.id, action: 'security.master_key_rotated', entityType: 'workspace', entityId: workspace.id, details: { signingKeys: workspace.signingKey ? 1 : 0, webhooks: data.webhooks.filter(item => item.workspaceId === workspace.id && item.encryptedSecret).length, newKeyFingerprint: masterKeyFingerprint(newSecret) }, at });
    return counts;
  });
  const verified = await store.read(); rotateEncryptedSecrets(structuredClone(verified), newSecret, oldSecret);
  console.log(JSON.stringify({ ok: true, rotated, newKeyFingerprint: masterKeyFingerprint(newSecret), nextStep: '将 SHIPWITNESS_MASTER_KEY 更新为新密钥并重启全部应用实例' }, null, 2));
} finally { await store.close(); }
