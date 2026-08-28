import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { assertReleaseVersion } from '../lib/release.js';

const backupFolder = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;
const masterKey = process.env.SHIPWITNESS_MASTER_KEY;
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const fail = message => { console.error(JSON.stringify({ ok: false, targetVersion: pkg.version, error: message })); process.exit(1); };
if (!backupFolder || !databaseUrl) fail('用法：DATABASE_URL=... SHIPWITNESS_MASTER_KEY=... npm run upgrade:check -- <备份目录>');
try {
  const encodedKey = String(masterKey || '').trim(); const decodedKey = Buffer.from(encodedKey, 'base64');
  if (decodedKey.length !== 32 || decodedKey.toString('base64') !== encodedKey) fail('SHIPWITNESS_MASTER_KEY 必须是标准 Base64 编码的 32 字节密钥');
} catch { fail('SHIPWITNESS_MASTER_KEY 无效'); }
assertReleaseVersion(pkg.version);

const backupManifest = JSON.parse(await readFile(join(resolve(backupFolder), 'manifest.json'), 'utf8'));
const backupAgeHours = (Date.now() - new Date(backupManifest.createdAt).getTime()) / 3_600_000;
if (!Number.isFinite(backupAgeHours)) fail('备份创建时间无效');
if (backupAgeHours < -0.1) fail('备份创建时间晚于当前系统时间');
if (backupAgeHours > Number(process.env.SHIPWITNESS_MAX_BACKUP_AGE_HOURS || 24) && process.env.SHIPWITNESS_ALLOW_STALE_BACKUP !== 'YES') fail(`备份已超过允许时限：${backupAgeHours.toFixed(1)} 小时`);

const verifyExit = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [new URL('./verify-backup.js', import.meta.url).pathname, resolve(backupFolder)], { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', resolveExit);
});
if (verifyExit !== 0) fail('升级前备份校验失败');

const migrationFiles = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
const targetSchema = Math.max(...migrationFiles.map(name => Number(name.match(/^\d+/)[0])));
const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
try {
  const table = await pool.query("SELECT to_regclass('public.schema_migrations') AS name");
  if (!table.rows[0].name) fail('目标数据库尚未初始化，不能执行升级检查');
  const versions = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => Number(row.version));
  const currentSchema = versions.at(-1) || 0;
  if (versions.some(version => version > targetSchema)) fail(`数据库版本 ${currentSchema} 高于应用支持的 ${targetSchema}，禁止降级启动`);
  console.log(JSON.stringify({ ok: true, targetVersion: pkg.version, currentSchema, targetSchema, pendingMigrations: migrationFiles.filter(name => Number(name.match(/^\d+/)[0]) > currentSchema), backupVerified: true, backupApplicationVersion: backupManifest.applicationVersion || null, backupSchemaVersion: backupManifest.schemaVersion || null, backupAgeHours: Number(backupAgeHours.toFixed(2)) }, null, 2));
} finally { await pool.end(); }
