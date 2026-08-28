import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectReleaseFiles, releaseSchema, verifyReleaseDirectory } from '../lib/release.js';

test('release manifest verifies every payload file and detects tampering', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-release-'));
  await mkdir(join(folder, 'docs'));
  await writeFile(join(folder, 'server.js'), 'console.log("release")\n');
  await writeFile(join(folder, 'docs', 'README.md'), '# Release\n');
  await writeFile(join(folder, 'SBOM.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { name: 'shipwitness', version: '0.4.0-dev.5' } }, components: [{ name: 'playwright' }], dependencies: [] }));
  const files = await collectReleaseFiles(folder);
  await writeFile(join(folder, 'RELEASE.json'), JSON.stringify({ schema: releaseSchema, version: '0.4.0-dev.5', commit: 'a'.repeat(40), files }));
  const result = await verifyReleaseDirectory(folder);
  assert.equal(result.valid, true);
  assert.equal(result.filesVerified, 3);
  assert.deepEqual(result.sbom, { format: 'CycloneDX', specVersion: '1.5', components: 1 });
  await writeFile(join(folder, 'server.js'), 'changed\n');
  await assert.rejects(verifyReleaseDirectory(folder), /校验失败/);
});

test('release manifest requires an immutable Git commit', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-release-'));
  await writeFile(join(folder, 'server.js'), 'console.log("release")\n');
  const files = await collectReleaseFiles(folder);
  await writeFile(join(folder, 'RELEASE.json'), JSON.stringify({ schema: releaseSchema, version: '0.4.0-dev.5', files }));
  await assert.rejects(verifyReleaseDirectory(folder), /缺少有效的 Git 提交号/);
});

test('release verification rejects a missing or mismatched software bill of materials', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-release-'));
  await writeFile(join(folder, 'server.js'), 'console.log("release")\n');
  await writeFile(join(folder, 'SBOM.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { name: 'other-product', version: '0.4.0-dev.5' } }, components: [{ name: 'playwright' }], dependencies: [] }));
  const files = await collectReleaseFiles(folder);
  await writeFile(join(folder, 'RELEASE.json'), JSON.stringify({ schema: releaseSchema, version: '0.4.0-dev.5', commit: 'b'.repeat(40), files }));
  await assert.rejects(verifyReleaseDirectory(folder), /SBOM 根组件/);
});
