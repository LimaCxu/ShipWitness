import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

const root = await mkdtemp(join(tmpdir(), 'shipwitness-self-smoke-'));
const server = createApp({
  storeFile: join(root, 'store.json'),
  signingSecret: randomBytes(32).toString('base64'),
  backupRoot: join(root, 'backups')
});

const required = (condition, message) => { if (!condition) throw new Error(message); };
let base;
let cookie;

async function request(path, { method = 'GET', body, authenticated = true } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(authenticated && cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`${method} ${path} 失败（${response.status}）：${payload?.error || 'unexpected response'}`);
  return { response, payload };
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const health = (await request('/api/health', { authenticated: false })).payload;
  const setup = await request('/api/setup', { authenticated: false, method: 'POST', body: { workspaceName: '交付自检工作区', name: '自检管理员', email: 'self-smoke@shipwitness.invalid', password: randomBytes(24).toString('base64url') } });
  cookie = setup.response.headers.get('set-cookie')?.split(';')[0]; required(cookie, '初始化后未获得安全会话');

  const project = (await request('/api/projects', { method: 'POST', body: { name: 'ShipWitness 自验收', repo: process.cwd(), url: `${base}/`, branch: 'main', handoffMode: 'file' } })).payload;
  const contract = (await request('/api/contracts', { method: 'POST', body: {
    projectId: project.id, code: 'SELF-SMOKE-01', title: '登录入口真实可用', description: '全新浏览器必须看到登录标题和密码输入框。', category: '交付自检', severity: 'blocker',
    steps: [{ action: 'goto', path: '/' }, { action: 'expectVisible', selector: '#authPassword' }, { action: 'expectText', selector: '#authTitle', value: '登录 ShipWitness' }]
  } })).payload;
  const run = (await request('/api/runs', { method: 'POST', body: { projectId: project.id, requirement: '验证真实浏览器、截图、门禁和签名卷宗闭环' } })).payload;
  const executed = (await request(`/api/runs/${run.id}/execute`, { method: 'POST' })).payload;
  required(executed.status === 'completed' && executed.execution?.verdict === 'passed', `真实浏览器断言未通过：${[executed.execution?.summary, ...(executed.execution?.criteriaResults || []).map(item => item.reason)].filter(Boolean).join('；') || executed.status}`);
  required(executed.execution?.browser?.engine === 'chromium', '未使用 Chromium 真实执行器');
  const criterion = executed.execution.criteriaResults?.[0]; required(criterion?.result === 'passed' && criterion.screenshotUrl, '验收结果缺少通过结论或截图');
  const evidence = (await request(criterion.screenshotUrl)).payload;
  required(Buffer.isBuffer(evidence) && evidence.length > 1_000, '截图证据不完整');

  await request('/api/decisions', { method: 'POST', body: { runId: run.id, verdict: 'approve', note: '隔离交付自检通过' } });
  const gate = (await request(`/api/gates/${run.id}`)).payload; required(gate.status === 'pass', `发布门禁未通过：${gate.reasons?.join('；')}`);
  const signed = (await request(`/api/dossiers/${run.id}/sign`, { method: 'POST' })).payload;
  const verified = (await request(`/api/signed-dossiers/${signed.id}`)).payload; required(verified.valid === true, '签名卷宗离线校验失败');

  console.log(JSON.stringify({
    ok: true, schema: 'shipwitness.self-smoke.v1', version: health.version, storage: health.storage.engine,
    browser: executed.execution.browser.engine, verdict: executed.execution.verdict, criteriaPassed: executed.execution.criteriaResults.filter(item => item.result === 'passed').length,
    stepsPassed: criterion.steps.filter(item => item.status === 'passed').length, evidence: { bytes: evidence.length, sha256: createHash('sha256').update(evidence).digest('hex') },
    gate: gate.status, signedDossier: { algorithm: signed.signature.algorithm, valid: verified.valid }
  }, null, 2));
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await server.closeStore?.();
  await rm(root, { recursive: true, force: true });
}
