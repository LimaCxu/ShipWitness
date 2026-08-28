import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReleaseFiles, releaseSchema, sha256File } from '../lib/release.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const outputRoot = resolve(process.argv[2] || join(root, 'dist'));
const releaseName = `shipwitness-${pkg.version}`;
const staging = join(outputRoot, releaseName);
const archive = join(outputRoot, `${releaseName}.tar.gz`);
const included = ['.env.example', 'CHANGELOG.md', 'Dockerfile', 'LICENSE', 'README.md', 'SECURITY.md', 'compose.yaml', 'package.json', 'package-lock.json', 'server.js', 'lib', 'migrations', 'outputs', 'scripts', 'docs'];

await mkdir(outputRoot, { recursive: true });
await rm(staging, { recursive: true, force: true });
await rm(archive, { force: true });
for (const path of included) await cp(join(root, path), join(staging, path), { recursive: true });
const files = await collectReleaseFiles(staging);
const manifest = { schema: releaseSchema, version: pkg.version, commit: process.env.SHIPWITNESS_RELEASE_COMMIT || null, createdAt: new Date().toISOString(), files };
await writeFile(join(staging, 'RELEASE.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

await new Promise((resolveRun, reject) => {
  const child = spawn('tar', ['-czf', archive, '-C', outputRoot, releaseName], { stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`tar 退出码 ${code}`)));
});
const checksum = await sha256File(archive);
await writeFile(`${archive}.sha256`, `${checksum}  ${basename(archive)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ ok: true, version: pkg.version, directory: staging, archive, sha256: checksum, files: files.length }, null, 2));
