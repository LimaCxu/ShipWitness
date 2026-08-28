import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { assertRollbackImage, rollbackCommands } from '../lib/operations.js';

const dryRun = process.argv.includes('--dry-run');
const backupArgument = process.argv.find(item => item !== '--dry-run' && item !== process.argv[0] && item !== process.argv[1]);
const backupFolder = backupArgument && resolve(backupArgument);
const manifest = backupFolder && JSON.parse(await readFile(join(backupFolder, 'manifest.json'), 'utf8'));
if (!backupFolder || !manifest) throw new Error('用法：SHIPWITNESS_ROLLBACK_IMAGE=shipwitness:<version> npm run rollback -- <备份目录> [--dry-run]');
const image = assertRollbackImage(process.env.SHIPWITNESS_ROLLBACK_IMAGE, manifest.applicationVersion);
const verifyExit = await new Promise((resolveExit, reject) => { const child = spawn(process.execPath, [new URL('./verify-backup.js', import.meta.url).pathname, backupFolder], { stdio: 'inherit' }); child.on('error', reject); child.on('exit', resolveExit); });
if (verifyExit !== 0) throw new Error('备份校验失败，拒绝回退');
const commands = rollbackCommands({ image, backupFolder });
if (dryRun) { console.log(JSON.stringify({ ok: true, dryRun: true, image, backupVersion: manifest.applicationVersion, commands: commands.map(parts => parts.join(' ')) }, null, 2)); process.exit(0); }
if (process.env.SHIPWITNESS_ROLLBACK_CONFIRM !== 'YES') throw new Error('回退会停止应用并覆盖数据库和证据；确认目标后设置 SHIPWITNESS_ROLLBACK_CONFIRM=YES');
const env = { ...process.env, SHIPWITNESS_IMAGE: image };
for (const [command, ...args] of commands) await new Promise((resolveRun, reject) => { const child = spawn(command, args, { env, stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}；应用保持停止，请检查后人工恢复`))); });
const healthUrl = process.env.SHIPWITNESS_HEALTH_URL || 'http://127.0.0.1:4173/api/health';
let health;
for (let attempt = 0; attempt < 30; attempt += 1) { try { const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) }); health = await response.json(); if (response.ok && health.version === manifest.applicationVersion) break; } catch {} await new Promise(resolveWait => setTimeout(resolveWait, 2000)); }
if (health?.version !== manifest.applicationVersion) throw new Error(`回退后健康检查未确认版本 ${manifest.applicationVersion}`);
console.log(JSON.stringify({ ok: true, image, restoredBackup: backupFolder, health }, null, 2));
