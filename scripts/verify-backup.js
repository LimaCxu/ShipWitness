import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const folder = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('用法：npm run backup:verify -- <备份目录>');
const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
if (manifest.schema !== 'shipwitness.backup.v1') throw new Error('不支持的备份格式');
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const checks = [{ path: manifest.database.file, expected: manifest.database.sha256 }, ...manifest.evidence.map(item => ({ path: join('evidence', item.path), expected: item.sha256 }))];
for (const item of checks) {
  const actual = await hashFile(join(folder, item.path));
  if (actual !== item.expected) throw new Error(`备份校验失败：${item.path}`);
}
console.log(JSON.stringify({ ok: true, schema: manifest.schema, applicationVersion: manifest.applicationVersion || null, schemaVersion: manifest.schemaVersion || null, filesVerified: checks.length, createdAt: manifest.createdAt }, null, 2));
