import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from '../lib/backup-manager.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('backup manager lists and verifies only constrained manifest-backed restore points', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shipwitness-backup-manager-')); const backupRoot = join(root, 'backups'); const id = '2026-08-28T10-00-00-000Z'; const folder = join(backupRoot, id); await mkdir(join(folder, 'evidence'), { recursive: true });
  const database = Buffer.from('postgres-custom-dump'); const evidence = Buffer.from('screenshot'); await writeFile(join(folder, 'database.dump'), database); await writeFile(join(folder, 'evidence', 'proof.png'), evidence);
  await writeFile(join(folder, 'manifest.json'), JSON.stringify({ schema: 'shipwitness.backup.v1', createdAt: '2026-08-28T10:00:00.000Z', applicationVersion: '0.4.0-dev.41', schemaVersion: 16, database: { file: 'database.dump', sha256: sha256(database) }, evidence: [{ path: 'proof.png', sha256: sha256(evidence) }] }));
  const manager = new BackupManager({ artifactsDir: join(root, 'evidence'), backupRoot, version: '0.4.0-dev.41', schemaVersion: 16 });
  assert.equal(manager.available, false); assert.equal((await manager.list()).length, 1); assert.equal((await manager.verify(id)).filesVerified, 2); assert.equal((await manager.restorePreflight(id)).canRestore, true);
  await assert.rejects(manager.verify('../outside'), /备份标识无效/);
  await writeFile(join(folder, 'evidence', 'proof.png'), 'tampered'); await assert.rejects(manager.verify(id), /备份校验失败/);
});
