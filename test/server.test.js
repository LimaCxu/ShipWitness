import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

const request = async (base, path, options = {}) => {
  const response = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' }, ...options });
  return { status: response.status, body: await response.json() };
};

test('project, preflight, run and dossier API work together', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await request(base, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const created = await request(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '测试项目', repo: folder, url: `${base}/`, branch: 'main', handoffMode: 'file' }) });
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^prj_/);

  const preflight = await request(base, `/api/projects/${created.body.id}/preflight`, { method: 'POST' });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.checks.url.status, 'ready');
  assert.equal(preflight.body.checks.repo.status, 'warning');
  assert.equal(preflight.body.checks.handoff.status, 'ready');

  const contract = await request(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: created.body.id, code: 'AUTH-01', title: '权限隔离', description: '普通成员不能进入后台', category: '权限', severity: 'blocker' }) });
  assert.equal(contract.status, 201);
  assert.equal(contract.body.version, 1);

  const edited = await request(base, `/api/contracts/${contract.body.id}`, { method: 'PATCH', body: JSON.stringify({ title: '后台权限隔离' }) });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.version, 2);

  const contracts = await request(base, `/api/contracts?projectId=${created.body.id}`);
  assert.equal(contracts.body.length, 1);

  const run = await request(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: created.body.id, requirement: '用户可以安全退出', criteria: [] }) });
  assert.equal(run.status, 201);
  assert.equal(run.body.status, 'queued');
  assert.equal(run.body.criteria[0].contractId, contract.body.id);
  assert.equal(run.body.criteria[0].version, 2);

  const execution = await request(base, `/api/runs/${run.body.id}/execute`, { method: 'POST' });
  assert.equal(execution.status, 200);
  assert.equal(execution.body.status, 'completed');
  assert.equal(execution.body.execution.target.httpStatus, 200);
  assert.equal(execution.body.execution.verdict, 'evidence_insufficient');
  assert.equal(execution.body.execution.criteriaResults[0].result, 'evidence_insufficient');

  const detail = await request(base, `/api/runs/${run.body.id}`);
  assert.equal(detail.body.execution.executor, 'shipwitness-basic-v1');

  const issue = await request(base, '/api/issues', { method: 'POST', body: JSON.stringify({ runId: run.body.id, title: '退出失败', contract: '退出后回到登录页', actual: '仍能看到数据', expected: '跳转登录页' }) });
  assert.equal(issue.status, 201);

  const decision = await request(base, '/api/decisions', { method: 'POST', body: JSON.stringify({ runId: run.body.id, owner: '负责人', verdict: 'hold' }) });
  assert.equal(decision.status, 201);

  const dossier = await request(base, `/api/dossiers/${run.body.id}`);
  assert.equal(dossier.status, 200);
  assert.equal(dossier.body.issues.length, 1);
  assert.equal(dossier.body.decisions.length, 1);
});

test('invalid payloads return a useful 400 response', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await request(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '缺少路径' }) });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, '项目目录不能为空');
});

test('browser executor performs a real assertion and records screenshot evidence', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-browser-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const project = await request(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '浏览器验收', repo: folder, url: `${base}/`, branch: 'main', handoffMode: 'file' }) });
  const contract = await request(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, code: 'PAGE-01', title: '页面标题可见', description: '首页显示 ShipWitness 产品名', steps: [{ action: 'goto', path: '/' }, { action: 'expectText', selector: 'body', value: 'ShipWitness' }] }) });
  assert.equal(contract.status, 201);
  assert.equal(contract.body.steps.length, 2);

  const run = await request(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '产品首页可以打开', criteria: [] }) });
  const execution = await request(base, `/api/runs/${run.body.id}/execute`, { method: 'POST' });
  assert.equal(execution.status, 200);
  assert.equal(execution.body.execution.executor, 'shipwitness-browser-v1');
  assert.equal(execution.body.execution.verdict, 'passed');
  assert.equal(execution.body.execution.criteriaResults[0].steps.length, 2);

  const screenshot = await fetch(`${base}${execution.body.execution.criteriaResults[0].screenshotUrl}`);
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.headers.get('content-type'), 'image/png');
  assert.ok((await screenshot.arrayBuffer()).byteLength > 1_000);
});
