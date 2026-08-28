import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL 不能为空');
const evidenceDir = resolve(process.env.SHIPWITNESS_ARTIFACTS_DIR || 'data/evidence');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = resolve(process.argv[2] || join('backups', stamp));

function pgEnvironment(value) {
  const url = new URL(value);
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: url.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer' };
}

const run = (command, args) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { env: pgEnvironment(databaseUrl), stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} 退出码 ${code}`)));
});
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');

await mkdir(dirname(destination), { recursive: true });
await mkdir(destination, { recursive: false });
const dumpFile = join(destination, 'database.dump');
await run('pg_dump', ['--format=custom', '--no-owner', `--file=${dumpFile}`]);
try { await cp(evidenceDir, join(destination, 'evidence'), { recursive: true, errorOnExist: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const evidenceFiles = [];
async function collect(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = join(prefix, entry.name); const absolute = join(folder, entry.name);
    if (entry.isDirectory()) await collect(absolute, relative); else evidenceFiles.push({ path: relative, sha256: await hashFile(absolute) });
  }
}
try { await collect(join(destination, 'evidence')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const manifest = { schema: 'shipwitness.backup.v1', createdAt: new Date().toISOString(), database: { file: basename(dumpFile), sha256: await hashFile(dumpFile) }, evidence: evidenceFiles };
await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: true, destination, evidenceFiles: evidenceFiles.length }, null, 2));
