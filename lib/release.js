import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const releaseSchema = 'shipwitness.release.v1';

export async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function collectReleaseFiles(root, folder = root) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const absolute = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await collectReleaseFiles(root, absolute));
    else files.push({ path: relative(root, absolute).split('\\').join('/'), sha256: await sha256File(absolute) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function assertReleaseVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`版本号无效：${version}`);
  return version;
}

export async function verifyReleaseDirectory(folder) {
  const manifest = JSON.parse(await readFile(join(folder, 'RELEASE.json'), 'utf8'));
  if (manifest.schema !== releaseSchema) throw new Error('不支持的发布包格式');
  assertReleaseVersion(manifest.version);
  const expected = new Map(manifest.files.map(item => [item.path, item.sha256]));
  if (expected.size !== manifest.files.length) throw new Error('发布清单包含重复路径');
  const actual = await collectReleaseFiles(folder);
  const payloadFiles = actual.filter(item => item.path !== 'RELEASE.json');
  for (const item of payloadFiles) {
    if (!expected.has(item.path)) throw new Error(`发布包存在未登记文件：${item.path}`);
    if (expected.get(item.path) !== item.sha256) throw new Error(`发布包校验失败：${item.path}`);
    expected.delete(item.path);
  }
  if (expected.size) throw new Error(`发布包缺少文件：${[...expected.keys()][0]}`);
  return { valid: true, version: manifest.version, filesVerified: payloadFiles.length, commit: manifest.commit || null };
}
