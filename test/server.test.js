import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

const request = async (base, path, options = {}) => {
  const response = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' }, ...options });
  return { status: response.status, body: await response.json(), headers: response.headers };
};

const setupOwner = async base => {
  const result = await request(base, '/api/setup', { method: 'POST', body: JSON.stringify({ workspaceName: '测试工作区', name: '测试管理员', email: 'owner@example.com', password: 'correct-horse-battery' }) });
  assert.equal(result.status, 201);
  return result.headers.get('set-cookie').split(';')[0];
};

const authenticatedRequest = cookie => async (base, path, options = {}) => request(base, path, { ...options, headers: { 'content-type': 'application/json', cookie, ...options.headers } });

test('project, preflight, run and dossier API work together', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await request(base, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const cookie = await setupOwner(base);
  const authRequest = authenticatedRequest(cookie);

  const created = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '测试项目', repo: folder, url: `${base}/`, branch: 'main', handoffMode: 'file' }) });
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^prj_/);

  const preflight = await authRequest(base, `/api/projects/${created.body.id}/preflight`, { method: 'POST' });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.checks.url.status, 'ready');
  assert.equal(preflight.body.checks.repo.status, 'warning');
  assert.equal(preflight.body.checks.handoff.status, 'ready');

  const contract = await authRequest(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: created.body.id, code: 'AUTH-01', title: '权限隔离', description: '普通成员不能进入后台', category: '权限', severity: 'blocker' }) });
  assert.equal(contract.status, 201);
  assert.equal(contract.body.version, 1);

  const edited = await authRequest(base, `/api/contracts/${contract.body.id}`, { method: 'PATCH', body: JSON.stringify({ title: '后台权限隔离' }) });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.version, 2);

  const contracts = await authRequest(base, `/api/contracts?projectId=${created.body.id}`);
  assert.equal(contracts.body.length, 1);

  const run = await authRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: created.body.id, requirement: '用户可以安全退出', criteria: [] }) });
  assert.equal(run.status, 201);
  assert.equal(run.body.status, 'queued');
  assert.equal(run.body.criteria[0].contractId, contract.body.id);
  assert.equal(run.body.criteria[0].version, 2);

  const execution = await authRequest(base, `/api/runs/${run.body.id}/execute`, { method: 'POST' });
  assert.equal(execution.status, 200);
  assert.equal(execution.body.status, 'completed');
  assert.equal(execution.body.execution.target.httpStatus, 200);
  assert.equal(execution.body.execution.verdict, 'evidence_insufficient');
  assert.equal(execution.body.execution.criteriaResults[0].result, 'evidence_insufficient');

  const detail = await authRequest(base, `/api/runs/${run.body.id}`);
  assert.equal(detail.body.execution.executor, 'shipwitness-basic-v1');

  const issue = await authRequest(base, '/api/issues', { method: 'POST', body: JSON.stringify({ runId: run.body.id, criterionId: contract.body.id, title: '退出失败', contract: '退出后回到登录页', actual: '仍能看到数据', expected: '跳转登录页' }) });
  assert.equal(issue.status, 201);
  assert.equal(issue.body.status, 'open');
  assert.equal(issue.body.evidence.result, 'evidence_insufficient');

  const duplicate = await authRequest(base, '/api/issues', { method: 'POST', body: JSON.stringify({ runId: run.body.id, criterionId: contract.body.id, title: '重复返工', contract: '退出后回到登录页', actual: '仍能看到数据', expected: '跳转登录页' }) });
  assert.equal(duplicate.status, 409);

  const handedOff = await authRequest(base, `/api/issues/${issue.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'handed_off', note: '交回开发' }) });
  assert.equal(handedOff.status, 200);
  assert.equal(handedOff.body.timeline.length, 2);

  const listedIssues = await authRequest(base, `/api/issues?runId=${run.body.id}`);
  assert.equal(listedIssues.body.length, 1);

  const retest = await authRequest(base, `/api/issues/${issue.body.id}/retest`, { method: 'POST' });
  assert.equal(retest.status, 201);
  assert.equal(retest.body.run.parentRunId, run.body.id);
  assert.equal(retest.body.run.criteria.length, 1);

  const retestExecution = await authRequest(base, `/api/runs/${retest.body.run.id}/execute`, { method: 'POST' });
  assert.equal(retestExecution.status, 200);
  const refreshedIssues = await authRequest(base, `/api/issues?runId=${run.body.id}`);
  assert.equal(refreshedIssues.body[0].status, 'handed_off');

  const decision = await authRequest(base, '/api/decisions', { method: 'POST', body: JSON.stringify({ runId: run.body.id, owner: '负责人', verdict: 'hold' }) });
  assert.equal(decision.status, 201);

  const dossier = await authRequest(base, `/api/dossiers/${run.body.id}`);
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
  const cookie = await setupOwner(base);
  const result = await authenticatedRequest(cookie)(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '缺少路径' }) });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, '项目目录不能为空');
});

test('authentication, roles and workspace isolation prevent cross-tenant access', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-auth-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const anonymous = await request(base, '/api/projects');
  assert.equal(anonymous.status, 401);

  const cookie = await setupOwner(base);
  const authRequest = authenticatedRequest(cookie);
  const session = await authRequest(base, '/api/session');
  const originalWorkspaceId = session.body.workspace.id;

  const project = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '仅工作区一可见', repo: folder, url: `${base}/`, branch: 'main' }) });
  assert.equal(project.status, 201);

  const secondWorkspace = await authRequest(base, '/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '隔离工作区' }) });
  assert.equal(secondWorkspace.status, 201);
  const isolatedProjects = await authRequest(base, '/api/projects');
  assert.equal(isolatedProjects.body.length, 0);
  const hiddenProject = await authRequest(base, `/api/projects/${project.body.id}/preflight`, { method: 'POST' });
  assert.equal(hiddenProject.status, 404);

  const selected = await authRequest(base, `/api/workspaces/${originalWorkspaceId}/select`, { method: 'POST' });
  assert.equal(selected.status, 200);
  const visibleProjects = await authRequest(base, '/api/projects');
  assert.equal(visibleProjects.body.length, 1);

  const member = await authRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '普通成员', email: 'member@example.com', password: 'member-password-123', role: 'member' }) });
  assert.equal(member.status, 201);
  const login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'member@example.com', password: 'member-password-123' }) });
  assert.equal(login.status, 200);
  const memberCookie = login.headers.get('set-cookie').split(';')[0];
  const forbidden = await authenticatedRequest(memberCookie)(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '越权用户', email: 'forbidden@example.com', password: 'forbidden-password', role: 'member' }) });
  assert.equal(forbidden.status, 403);
  const forbiddenDecision = await authenticatedRequest(memberCookie)(base, '/api/decisions', { method: 'POST', body: JSON.stringify({ runId: 'run_unknown', owner: '普通成员', verdict: 'pass' }) });
  assert.equal(forbiddenDecision.status, 403);

  const logout = await authenticatedRequest(memberCookie)(base, '/api/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  const expired = await authenticatedRequest(memberCookie)(base, '/api/session');
  assert.equal(expired.status, 401);
});

test('browser executor performs a real assertion and records screenshot evidence', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-browser-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await setupOwner(base);
  const authRequest = authenticatedRequest(cookie);

  const project = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '浏览器验收', repo: folder, url: `${base}/`, branch: 'main', handoffMode: 'file' }) });
  const contract = await authRequest(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, code: 'PAGE-01', title: '页面标题可见', description: '首页显示 ShipWitness 产品名', steps: [{ action: 'goto', path: '/' }, { action: 'expectText', selector: 'body', value: 'ShipWitness' }] }) });
  assert.equal(contract.status, 201);
  assert.equal(contract.body.steps.length, 2);

  const run = await authRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '产品首页可以打开', criteria: [] }) });
  const execution = await authRequest(base, `/api/runs/${run.body.id}/execute`, { method: 'POST' });
  assert.equal(execution.status, 200);
  assert.equal(execution.body.execution.executor, 'shipwitness-browser-v1');
  assert.equal(execution.body.execution.verdict, 'passed');
  assert.equal(execution.body.execution.criteriaResults[0].steps.length, 2);

  const screenshot = await fetch(`${base}${execution.body.execution.criteriaResults[0].screenshotUrl}`, { headers: { cookie } });
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.headers.get('content-type'), 'image/png');
  assert.ok((await screenshot.arrayBuffer()).byteLength > 1_000);
});
