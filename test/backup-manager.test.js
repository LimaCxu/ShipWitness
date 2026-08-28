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

test('recovery drill only restores into a named isolated database and returns redacted evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shipwitness-recovery-drill-')); const backupRoot = join(root, 'backups'); const id = '2026-08-28T11-00-00-000Z'; const folder = join(backupRoot, id); await mkdir(folder, { recursive: true }); const database = Buffer.from('postgres-custom-dump'); await writeFile(join(folder, 'database.dump'), database); await writeFile(join(folder, 'manifest.json'), JSON.stringify({ schema: 'shipwitness.backup.v1', createdAt: '2026-08-28T11:00:00.000Z', applicationVersion: '0.4.0-dev.43', schemaVersion: 17, database: { file: 'database.dump', sha256: sha256(database) }, evidence: [] }));
  let command; const drillUrl = 'postgresql://drill-user:drill-password@db.internal/shipwitness_restore_drill'; const manager = new BackupManager({ databaseUrl: 'postgresql://live-user:live-password@db.internal/shipwitness', drillDatabaseUrl: drillUrl, artifactsDir: join(root, 'evidence'), backupRoot, version: '0.4.0-dev.43', schemaVersion: 17, commandRunner: async (...args) => { command = args; }, drillProbe: async value => { assert.equal(value, drillUrl); return { workspaces: 2, projects: 4, runs: 9, audit_events: 21, schema_version: 17 }; } });
  assert.equal(manager.drillAvailable, true); const result = await manager.drill(id); assert.equal(result.status, 'passed'); assert.deepEqual(result.counts, { workspaces: 2, projects: 4, runs: 9, auditEvents: 21 }); assert.equal(command[0], 'pg_restore'); assert.ok(command[1].includes('--dbname=shipwitness_restore_drill')); assert.equal(JSON.stringify(result).includes('drill-password'), false);
  const unsafe = new BackupManager({ databaseUrl: drillUrl, drillDatabaseUrl: drillUrl, artifactsDir: join(root, 'evidence'), backupRoot, version: '0.4.0-dev.43', schemaVersion: 17 }); assert.equal(unsafe.drillAvailable, false); await assert.rejects(unsafe.drill(id), /未安全配置/);
});
