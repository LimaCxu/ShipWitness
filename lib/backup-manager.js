import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';

const migrationFiles = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => /^\d+_.+\.sql$/.test(name));
export const currentSchemaVersion = Math.max(...migrationFiles.map(name => Number(name.match(/^\d+/)[0])));

const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const safeId = value => /^[0-9TZ-]{10,40}$/.test(String(value || ''));

function pgEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: url.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer' };
}

const run = (command, args, env) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
  child.stderr.on('data', chunk => { error += chunk.toString(); });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} 执行失败：${error.trim().slice(0, 500) || `退出码 ${code}`}`)));
});

const probeDrillDatabase = async databaseUrl => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await pool.query("SELECT (SELECT count(*)::int FROM workspaces) AS workspaces, (SELECT count(*)::int FROM projects) AS projects, (SELECT count(*)::int FROM runs) AS runs, (SELECT count(*)::int FROM auditEvents) AS audit_events, (SELECT max(version)::int FROM schema_migrations) AS schema_version");
    return result.rows[0];
  } finally { await pool.end(); }
};

async function collectEvidence(folder, prefix = '', output = []) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = join(prefix, entry.name); const absolute = join(folder, entry.name);
    if (entry.isDirectory()) await collectEvidence(absolute, relative, output); else output.push({ path: relative, sha256: await hashFile(absolute) });
  }
  return output;
}

export class BackupManager {
  constructor({ databaseUrl, drillDatabaseUrl, artifactsDir, backupRoot, version, schemaVersion, commandRunner = run, drillProbe = probeDrillDatabase }) {
    this.databaseUrl = databaseUrl || null; this.drillDatabaseUrl = drillDatabaseUrl || null; this.artifactsDir = resolve(artifactsDir); this.backupRoot = resolve(backupRoot); this.version = version; this.schemaVersion = schemaVersion; this.commandRunner = commandRunner; this.drillProbe = drillProbe;
  }

  get available() { return Boolean(this.databaseUrl); }
  get drillAvailable() {
    if (!this.databaseUrl || !this.drillDatabaseUrl) return false;
    const live = new URL(this.databaseUrl); const drill = new URL(this.drillDatabaseUrl); const drillName = decodeURIComponent(drill.pathname.slice(1));
    return live.toString() !== drill.toString() && /(?:_drill|_restore_drill)$/.test(drillName);
  }
  folder(id) { if (!safeId(id)) throw Object.assign(new Error('备份标识无效'), { status: 400 }); const folder = resolve(this.backupRoot, id); if (!folder.startsWith(`${this.backupRoot}${sep}`)) throw Object.assign(new Error('备份路径无效'), { status: 400 }); return folder; }

  async readManifest(id) {
    try { const manifest = JSON.parse(await readFile(join(this.folder(id), 'manifest.json'), 'utf8')); if (manifest.schema !== 'shipwitness.backup.v1') throw new Error('不支持的备份格式'); return manifest; }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('备份不存在'), { status: 404 }); throw error; }
  }

  async list() {
    try {
      const entries = await readdir(this.backupRoot, { withFileTypes: true }); const items = [];
      for (const entry of entries.filter(item => item.isDirectory() && safeId(item.name))) { try { const manifest = await this.readManifest(entry.name); items.push({ id: entry.name, createdAt: manifest.createdAt, applicationVersion: manifest.applicationVersion || null, schemaVersion: manifest.schemaVersion || null, evidenceFiles: manifest.evidence?.length || 0 }); } catch {} }
      return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async create() {
    if (!this.available) throw Object.assign(new Error('可视化备份仅支持 PostgreSQL 部署'), { status: 409 });
    await mkdir(this.backupRoot, { recursive: true }); const id = new Date().toISOString().replace(/[:.]/g, '-'); const destination = this.folder(id); await mkdir(destination, { recursive: false, mode: 0o700 });
    const dumpFile = join(destination, 'database.dump');
    try {
      await run('pg_dump', ['--format=custom', '--no-owner', `--file=${dumpFile}`], pgEnvironment(this.databaseUrl));
      try { await cp(this.artifactsDir, join(destination, 'evidence'), { recursive: true, errorOnExist: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let evidence = []; try { evidence = await collectEvidence(join(destination, 'evidence')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const manifest = { schema: 'shipwitness.backup.v1', createdAt: new Date().toISOString(), applicationVersion: this.version, schemaVersion: this.schemaVersion, database: { file: basename(dumpFile), sha256: await hashFile(dumpFile) }, evidence };
      await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); return { id, createdAt: manifest.createdAt, applicationVersion: manifest.applicationVersion, schemaVersion: manifest.schemaVersion, evidenceFiles: evidence.length };
    } catch (error) { await rm(destination, { recursive: true, force: true }); error.backupId = id; throw error; }
  }

  async verify(id) {
    const manifest = await this.readManifest(id); const folder = this.folder(id); const checks = [{ path: manifest.database.file, expected: manifest.database.sha256 }, ...(manifest.evidence || []).map(item => ({ path: join('evidence', item.path), expected: item.sha256 }))];
    for (const item of checks) if (await hashFile(join(folder, item.path)) !== item.expected) throw Object.assign(new Error(`备份校验失败：${item.path}`), { status: 409 });
    return { id, valid: true, verifiedAt: new Date().toISOString(), filesVerified: checks.length, createdAt: manifest.createdAt, applicationVersion: manifest.applicationVersion || null, schemaVersion: manifest.schemaVersion || null };
  }

  async restorePreflight(id) {
    const verified = await this.verify(id); const schemaCompatible = Number(verified.schemaVersion) <= this.schemaVersion;
    return { ...verified, schemaCompatible, canRestore: schemaCompatible, requiresMaintenanceMode: true, command: `SHIPWITNESS_RESTORE_CONFIRM=YES npm run restore -- ${this.folder(id)}`, warning: '恢复会覆盖目标数据库。请先停止应用，并优先恢复到独立数据库完成演练。' };
  }

  async drill(id) {
    if (!this.drillAvailable) throw Object.assign(new Error('恢复演练数据库未安全配置：必须使用名称以 _drill 或 _restore_drill 结尾的独立数据库'), { status: 409 });
    const verified = await this.verify(id); if (Number(verified.schemaVersion) > this.schemaVersion) throw Object.assign(new Error('备份 Schema 高于当前应用，不能演练'), { status: 409 });
    const startedAt = new Date().toISOString(); const manifest = await this.readManifest(id); const started = Date.now();
    const drillEnvironment = pgEnvironment(this.drillDatabaseUrl);
    await this.commandRunner('pg_restore', ['--clean', '--if-exists', '--no-owner', `--dbname=${drillEnvironment.PGDATABASE}`, join(this.folder(id), manifest.database.file)], drillEnvironment);
    const counts = await this.drillProbe(this.drillDatabaseUrl);
    return { backupId: id, status: 'passed', startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started, applicationVersion: verified.applicationVersion, schemaVersion: Number(counts.schema_version), filesVerified: verified.filesVerified, counts: { workspaces: Number(counts.workspaces), projects: Number(counts.projects), runs: Number(counts.runs), auditEvents: Number(counts.audit_events) }, isolation: { targetValidated: true, databaseNameRedacted: true } };
  }
}
