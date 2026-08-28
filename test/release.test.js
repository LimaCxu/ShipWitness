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
  const files = await collectReleaseFiles(folder);
  await writeFile(join(folder, 'RELEASE.json'), JSON.stringify({ schema: releaseSchema, version: '0.4.0-dev.5', files }));
  const result = await verifyReleaseDirectory(folder);
  assert.equal(result.valid, true);
  assert.equal(result.filesVerified, 2);
  await writeFile(join(folder, 'server.js'), 'changed\n');
  await assert.rejects(verifyReleaseDirectory(folder), /校验失败/);
});
