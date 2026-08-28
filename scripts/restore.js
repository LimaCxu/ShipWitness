import { cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

if (process.env.SHIPWITNESS_RESTORE_CONFIRM !== 'YES') throw new Error('恢复会覆盖目标数据库；确认目标后设置 SHIPWITNESS_RESTORE_CONFIRM=YES');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL 不能为空');
const folder = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('用法：npm run restore -- <已校验的备份目录>');
const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
if (manifest.schema !== 'shipwitness.backup.v1') throw new Error('不支持的备份格式');
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const checks = [{ path: manifest.database.file, expected: manifest.database.sha256 }, ...manifest.evidence.map(item => ({ path: join('evidence', item.path), expected: item.sha256 }))];
for (const item of checks) if (await hashFile(join(folder, item.path)) !== item.expected) throw new Error(`备份校验失败：${item.path}`);
const url = new URL(databaseUrl);
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: url.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer' };
await new Promise((resolveRun, reject) => { const child = spawn('pg_restore', ['--clean', '--if-exists', '--no-owner', `--dbname=${env.PGDATABASE}`, join(folder, manifest.database.file)], { env, stdio: ['ignore', 'inherit', 'inherit'] }); child.on('error', reject); child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`pg_restore 退出码 ${code}`))); });
const evidenceDir = resolve(process.env.SHIPWITNESS_ARTIFACTS_DIR || 'data/evidence');
try { await cp(join(folder, 'evidence'), evidenceDir, { recursive: true, force: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log(JSON.stringify({ ok: true, restoredFrom: folder }, null, 2));
