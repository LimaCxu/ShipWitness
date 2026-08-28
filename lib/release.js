import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const releaseSchema = 'shipwitness.release.v1';
export const allowedProductionLicenses = new Set(['Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MIT', 'MIT-0']);

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

export function assertReleaseSbom(sbom, manifest) {
  if (sbom?.bomFormat !== 'CycloneDX' || !/^1\.[5-9]$/.test(String(sbom.specVersion || ''))) throw new Error('发布包缺少受支持的 CycloneDX SBOM');
  if (sbom.metadata?.component?.name !== 'shipwitness' || sbom.metadata?.component?.version !== manifest.version) throw new Error('SBOM 根组件与发布版本不一致');
  if (!Array.isArray(sbom.components) || !sbom.components.length || !Array.isArray(sbom.dependencies)) throw new Error('SBOM 依赖清单不完整');
  for (const component of sbom.components) {
    if (!String(component.purl || '').startsWith('pkg:npm/')) throw new Error(`SBOM 组件缺少 npm 包标识：${component.name || 'unknown'}`);
    const licenses = (component.licenses || []).map(item => item?.license?.id || item?.license?.name).filter(Boolean);
    if (!licenses.length) throw new Error(`SBOM 组件缺少许可证：${component.name || 'unknown'}`);
    const unapproved = licenses.find(license => !allowedProductionLicenses.has(license));
    if (unapproved) throw new Error(`SBOM 组件使用未批准许可证：${component.name || 'unknown'} · ${unapproved}`);
  }
  return sbom;
}

export async function verifyReleaseDirectory(folder) {
  const manifest = JSON.parse(await readFile(join(folder, 'RELEASE.json'), 'utf8'));
  if (manifest.schema !== releaseSchema) throw new Error('不支持的发布包格式');
  assertReleaseVersion(manifest.version);
  if (!/^[0-9a-f]{40}$/i.test(manifest.commit || '')) throw new Error('发布清单缺少有效的 Git 提交号');
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
  const sbom = assertReleaseSbom(JSON.parse(await readFile(join(folder, 'SBOM.cdx.json'), 'utf8')), manifest);
  const licenses = [...new Set(sbom.components.flatMap(component => (component.licenses || []).map(item => item?.license?.id || item?.license?.name).filter(Boolean)))].sort();
  return { valid: true, version: manifest.version, filesVerified: payloadFiles.length, commit: manifest.commit.toLowerCase(), sbom: { format: sbom.bomFormat, specVersion: sbom.specVersion, components: sbom.components.length, licenses } };
}
