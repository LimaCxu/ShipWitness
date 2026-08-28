import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { encryptSecret } from '../lib/signing.js';
import { JsonStore } from '../lib/store.js';

const signingSecret = Buffer.alloc(32, 7).toString('base64');

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
  let githubInput;
  const server = createApp({ storeFile: join(folder, 'store.json'), githubIssueCreator: async input => { githubInput = input; return { provider: 'github', id: '42', url: `https://github.com/${input.repo}/issues/42`, repo: input.repo }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await request(base, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.match(health.headers.get('permissions-policy'), /camera=\(\)/);
  const frontendScript = await fetch(`${base}/api.js`);
  assert.equal(frontendScript.status, 200);
  assert.equal(frontendScript.headers.get('cache-control'), 'no-cache');
  assert.match(await frontendScript.text(), /创建新任务并重试/);

  const cookie = await setupOwner(base);
  const authRequest = authenticatedRequest(cookie);

  const created = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '测试项目', repo: folder, url: `${base}/`, branch: 'main', handoffMode: 'github', githubRepo: 'example/shipwitness-test' }) });
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

  const handoff = await authRequest(base, `/api/issues/${issue.body.id}/handoff`);
  assert.equal(handoff.status, 200);
  assert.equal(handoff.body.schema, 'shipwitness.handoff.v1');
  assert.match(handoff.body.prompt, /不得修改已确认的验收标准/);

  const exported = await authRequest(base, `/api/issues/${issue.body.id}/export/github`, { method: 'POST' });
  assert.equal(exported.status, 201);
  assert.equal(exported.body.externalRef.id, '42');
  assert.equal(githubInput.repo, 'example/shipwitness-test');
  assert.match(githubInput.body, /实际结果/);
  const duplicateExport = await authRequest(base, `/api/issues/${issue.body.id}/export/github`, { method: 'POST' });
  assert.equal(duplicateExport.status, 409);

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

  const decision = await authRequest(base, '/api/decisions', { method: 'POST', body: JSON.stringify({ runId: run.body.id, verdict: 'hold', note: '证据仍然不足' }) });
  assert.equal(decision.status, 201);
  assert.equal(decision.body.owner, '测试管理员');

  const approvalRejected = await authRequest(base, '/api/decisions', { method: 'POST', body: JSON.stringify({ runId: run.body.id, verdict: 'approve' }) });
  assert.equal(approvalRejected.status, 409);
  const blockedGate = await authRequest(base, `/api/gates/${run.body.id}`);
  assert.equal(blockedGate.body.status, 'blocked');
  assert.equal(blockedGate.body.exitCode, 1);

  const audit = await authRequest(base, '/api/audit');
  assert.ok(audit.body.some(item => item.action === 'issue.exported'));
  assert.ok(audit.body.some(item => item.action === 'release.decision_recorded'));
  const auditIntegrity = await authRequest(base, '/api/audit/verify');
  assert.deepEqual(auditIntegrity.body.valid, true);

  const dossier = await authRequest(base, `/api/dossiers/${run.body.id}`);
  assert.equal(dossier.status, 200);
  assert.equal(dossier.body.issues.length, 1);
  assert.equal(dossier.body.decisions.length, 1);
  assert.equal(dossier.body.auditProof.valid, true);
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
  const externalTarget = await authenticatedRequest(cookie)(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '禁止的外部目标', repo: folder, url: 'https://unapproved.example.test', branch: 'main' }) });
  assert.equal(externalTarget.status, 400);
  assert.match(externalTarget.body.error, /未获管理员允许/);
  const longPassword = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'x'.repeat(129) }) });
  assert.equal(longPassword.status, 400);
  assert.match(longPassword.body.error, /128/);
});

test('run execution is claimed atomically and rejects a concurrent duplicate', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-concurrency-'));
  let releaseExecution; const blocked = new Promise(resolve => { releaseExecution = resolve; });
  const browserRunExecutor = async () => { await blocked; return { executor: 'test-browser', verdict: 'passed', summary: 'done', criteriaResults: [{ title: '并发', result: 'passed' }] }; };
  const server = createApp({ storeFile: join(folder, 'store.json'), browserRunExecutor });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const authRequest = authenticatedRequest(cookie);
  const project = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '并发项目', repo: folder, url: base, branch: 'main' }) });
  const contract = await authRequest(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, code: 'CON-01', title: '并发', description: '只执行一次', steps: [{ action: 'expectText', selector: 'body', value: 'ShipWitness' }] }) });
  assert.equal(contract.status, 201);
  const run = await authRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '并发只能执行一次' }) });
  const first = authRequest(base, `/api/runs/${run.body.id}/execute`, { method: 'POST' });
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = await authRequest(base, `/api/runs/${run.body.id}/execute`, { method: 'POST' });
  assert.equal(second.status, 409);
  releaseExecution();
  const firstCompleted = await first;
  assert.equal(firstCompleted.status, 200);
  assert.equal(firstCompleted.body.attemptNumber, 1);
  assert.equal((await authRequest(base, `/api/runs/${run.body.id}/execute`, { method: 'POST' })).status, 409);
  const retry = await authRequest(base, `/api/runs/${run.body.id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 201);
  assert.notEqual(retry.body.id, run.body.id);
  assert.equal(retry.body.retryOfRunId, run.body.id);
  assert.equal(retry.body.rootRunId, run.body.id);
  assert.equal(retry.body.attemptNumber, 2);
  assert.equal((await authRequest(base, `/api/runs/${retry.body.id}/execute`, { method: 'POST' })).status, 200);

  const staleRun = await authRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '卡死任务可以接管' }) });
  const store = new JsonStore(join(folder, 'store.json'));
  await store.update(data => { const item = data.runs.find(value => value.id === staleRun.body.id); item.status = 'running'; item.startedAt = new Date(Date.now() - 16 * 60_000).toISOString(); });
  const recovered = await authRequest(base, `/api/runs/${staleRun.body.id}/execute`, { method: 'POST' });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.recoveryCount, 1);
  const audit = await authRequest(base, '/api/audit');
  assert.ok(audit.body.some(item => item.action === 'run.retry_created'));
  assert.ok(audit.body.some(item => item.action === 'run.recovered'));
});

test('failed executor preserves failure evidence and can create a separate retry', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-retry-'));
  const server = createApp({ storeFile: join(folder, 'store.json'), browserRunExecutor: async () => { throw new Error('executor crashed'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const authRequest = authenticatedRequest(cookie);
  const project = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '失败恢复项目', repo: folder, url: base, branch: 'main' }) });
  await authRequest(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, code: 'REC-01', title: '恢复', description: '执行器失败可重试', steps: [{ action: 'expectText', selector: 'body', value: 'ShipWitness' }] }) });
  const run = await authRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '保留失败证据' }) });
  assert.equal((await authRequest(base, `/api/runs/${run.body.id}/execute`, { method: 'POST' })).status, 500);
  const failed = await authRequest(base, `/api/runs/${run.body.id}`);
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.failure, '执行器发生内部错误');
  assert.ok(failed.body.failedAt);
  const retry = await authRequest(base, `/api/runs/${run.body.id}/retry`, { method: 'POST' });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.attemptNumber, 2);
  assert.equal((await authRequest(base, `/api/runs/${run.body.id}`)).body.status, 'failed');
});

test('workspace invitations are one-time, revocable, expiring and support existing accounts', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-invite-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const ownerCookie = await setupOwner(base); const ownerRequest = authenticatedRequest(ownerCookie);

  const created = await ownerRequest(base, '/api/invitations', { method: 'POST', body: JSON.stringify({ name: '受邀成员', email: 'invited@example.com', role: 'approver', expiresInHours: 24 }) });
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^swi_/);
  assert.match(created.body.invitePath, /^\/?\?invite=/);
  const listed = await ownerRequest(base, '/api/invitations');
  assert.equal(listed.body[0].status, 'pending');
  assert.equal('tokenHash' in listed.body[0], false);
  const preview = await request(base, `/api/invitations/${created.body.token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.existingAccount, false);
  assert.equal(preview.body.workspace.id, undefined);
  assert.match(preview.body.maskedEmail, /\*\*\*@/);
  assert.equal((await request(base, `/api/invitations/${'x'.repeat(201)}`)).status, 410);
  const accepted = await request(base, `/api/invitations/${created.body.token}`, { method: 'POST', body: JSON.stringify({ name: '受邀成员', password: 'invited-password-123' }) });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.role, 'approver');
  const invitedCookie = accepted.headers.get('set-cookie').split(';')[0];
  assert.equal((await authenticatedRequest(invitedCookie)(base, '/api/session')).body.user.email, 'invited@example.com');
  assert.equal((await request(base, `/api/invitations/${created.body.token}`)).status, 410);

  const revoked = await ownerRequest(base, '/api/invitations', { method: 'POST', body: JSON.stringify({ email: 'revoked@example.com', role: 'member' }) });
  assert.equal((await ownerRequest(base, `/api/invitations/${revoked.body.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(base, `/api/invitations/${revoked.body.token}`)).status, 410);
  assert.equal((await ownerRequest(base, '/api/invitations', { method: 'POST', body: JSON.stringify({ email: 'invalid-expiry@example.com', expiresInHours: 0 }) })).status, 400);
  const expired = await ownerRequest(base, '/api/invitations', { method: 'POST', body: JSON.stringify({ email: 'expired@example.com', expiresInHours: 1 }) });
  const inviteStore = new JsonStore(join(folder, 'store.json'));
  await inviteStore.update(data => { data.invitations.find(item => item.id === expired.body.id).expiresAt = new Date(Date.now() - 1_000).toISOString(); });
  assert.equal((await request(base, `/api/invitations/${expired.body.token}`)).status, 410);
  const firstWorkspaceAudit = await ownerRequest(base, '/api/audit');
  assert.ok(firstWorkspaceAudit.body.some(item => item.action === 'invitation.created'));
  assert.ok(firstWorkspaceAudit.body.some(item => item.action === 'invitation.revoked'));
  assert.ok(firstWorkspaceAudit.body.some(item => item.action === 'invitation.accepted'));

  const workspaceTwo = await ownerRequest(base, '/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '第二工作区' }) });
  assert.equal(workspaceTwo.status, 201);
  const existingInvite = await ownerRequest(base, '/api/invitations', { method: 'POST', body: JSON.stringify({ email: 'invited@example.com', role: 'member' }) });
  assert.equal((await request(base, `/api/invitations/${existingInvite.body.token}`)).body.existingAccount, true);
  assert.equal((await request(base, `/api/invitations/${existingInvite.body.token}`, { method: 'POST', body: JSON.stringify({ password: 'wrong-password' }) })).status, 401);
  const existingAccepted = await request(base, `/api/invitations/${existingInvite.body.token}`, { method: 'POST', body: JSON.stringify({ password: 'invited-password-123' }) });
  assert.equal(existingAccepted.status, 200);
  assert.equal(existingAccepted.body.workspace.id, workspaceTwo.body.id);

  const secondWorkspaceAudit = await ownerRequest(base, '/api/audit');
  assert.ok(secondWorkspaceAudit.body.some(item => item.action === 'invitation.created'));
  assert.ok(secondWorkspaceAudit.body.some(item => item.action === 'invitation.accepted'));
});

test('stale sending webhook delivery is reclaimed after an interrupted worker', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-webhook-lease-')); const store = new JsonStore(join(folder, 'store.json'));
  await store.update(data => {
    data.webhooks.push({ id: 'wh_stale', workspaceId: 'ws_stale', enabled: true, url: 'https://hooks.example.test/release', encryptedSecret: encryptSecret('whsec_test', signingSecret) });
    data.webhookDeliveries.push({ id: 'delivery_stale', workspaceId: 'ws_stale', webhookId: 'wh_stale', event: 'release.decision', payload: { verdict: 'approve' }, status: 'sending', attempts: 1, lastAttemptAt: new Date(Date.now() - 10 * 60_000).toISOString(), nextAttemptAt: new Date(Date.now() - 10 * 60_000).toISOString(), createdAt: new Date().toISOString() });
  });
  const server = createApp({ store, signingSecret, webhookSender: async () => ({ status: 204 }) });
  t.after(() => server.closeStore());
  assert.equal(await server.processWebhookDeliveries(), 1);
  const delivery = (await store.read()).webhookDeliveries[0];
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.attempts, 2);
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
  const membersBefore = await authRequest(base, '/api/members');
  const ownerMembership = membersBefore.body.find(item => item.email === 'owner@example.com');
  const lastOwnerDemotion = await authRequest(base, `/api/members/${ownerMembership.membershipId}`, { method: 'PATCH', body: JSON.stringify({ role: 'member' }) });
  assert.equal(lastOwnerDemotion.status, 409);
  const lastOwnerRemoval = await authRequest(base, `/api/members/${ownerMembership.membershipId}`, { method: 'DELETE' });
  assert.equal(lastOwnerRemoval.status, 409);
  const login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'member@example.com', password: 'member-password-123' }) });
  assert.equal(login.status, 200);
  const memberCookie = login.headers.get('set-cookie').split(';')[0];
  const forbidden = await authenticatedRequest(memberCookie)(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '越权用户', email: 'forbidden@example.com', password: 'forbidden-password', role: 'member' }) });
  assert.equal(forbidden.status, 403);
  const forbiddenDecision = await authenticatedRequest(memberCookie)(base, '/api/decisions', { method: 'POST', body: JSON.stringify({ runId: 'run_unknown', owner: '普通成员', verdict: 'pass' }) });
  assert.equal(forbiddenDecision.status, 403);

  const promoted = await authRequest(base, `/api/members/${member.body.membershipId}`, { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.role, 'owner');
  const memberOwnerRequest = authenticatedRequest(memberCookie);
  const memberKey = await memberOwnerRequest(base, '/api/api-keys', { method: 'POST', body: JSON.stringify({ name: '即将撤销的 Key', scopes: ['gate:read'] }) });
  assert.equal(memberKey.status, 201);

  const secondLogin = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'member@example.com', password: 'member-password-123' }) });
  const secondMemberCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  const passwordChanged = await memberOwnerRequest(base, '/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'member-password-123', newPassword: 'member-password-456' }) });
  assert.equal(passwordChanged.status, 200);
  assert.equal((await authenticatedRequest(secondMemberCookie)(base, '/api/session')).status, 401);
  assert.equal((await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'member@example.com', password: 'member-password-123' }) })).status, 401);
  assert.equal((await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'member@example.com', password: 'member-password-456' }) })).status, 200);

  const systemStatus = await authRequest(base, '/api/system/status');
  assert.equal(systemStatus.status, 200);
  assert.equal(systemStatus.body.audit.valid, true);
  assert.equal(systemStatus.body.members, 2);

  const resetPassword = await authRequest(base, `/api/members/${member.body.membershipId}/password`, { method: 'POST', body: JSON.stringify({ newPassword: 'temporary-reset-789' }) });
  assert.equal(resetPassword.status, 200);
  assert.ok(resetPassword.body.sessionsRevoked >= 1);
  assert.equal((await memberOwnerRequest(base, '/api/session')).status, 401);
  const resetLogin = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'member@example.com', password: 'temporary-reset-789' }) });
  assert.equal(resetLogin.status, 200);
  assert.equal(resetLogin.body.user.mustChangePassword, true);
  const resetCookie = resetLogin.headers.get('set-cookie').split(';')[0];
  const resetRequest = authenticatedRequest(resetCookie);
  assert.equal((await resetRequest(base, '/api/api-keys', { method: 'POST', body: JSON.stringify({ name: '不应创建', scopes: ['gate:read'] }) })).status, 428);
  assert.equal((await resetRequest(base, '/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'temporary-reset-789', newPassword: 'member-password-999' }) })).status, 200);
  assert.equal((await resetRequest(base, '/api/api-keys', { method: 'POST', body: JSON.stringify({ name: '改密后可创建', scopes: ['gate:read'] }) })).status, 201);

  const store = new JsonStore(join(folder, 'store.json'));
  await store.update(data => data.runs.push({ id: 'run_failed_alert', workspaceId: originalWorkspaceId, status: 'failed', createdAt: new Date().toISOString() }));
  const refreshedAlerts = await authRequest(base, '/api/alerts/refresh', { method: 'POST' });
  assert.equal(refreshedAlerts.status, 200);
  const failedRunAlert = refreshedAlerts.body.find(item => item.sourceKey === 'runs.failed');
  assert.equal(failedRunAlert.status, 'open');
  const acknowledged = await authRequest(base, `/api/alerts/${failedRunAlert.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'acknowledged' }) });
  assert.equal(acknowledged.body.status, 'acknowledged');
  const prematureResolution = await authRequest(base, `/api/alerts/${failedRunAlert.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved', resolution: '尚未修复' }) });
  assert.equal(prematureResolution.status, 409);
  await store.update(data => { data.runs.find(item => item.id === 'run_failed_alert').status = 'completed'; });
  const resolvedAlerts = await authRequest(base, '/api/alerts/refresh', { method: 'POST' });
  assert.equal(resolvedAlerts.body.find(item => item.id === failedRunAlert.id).status, 'resolved');

  const retention = await authRequest(base, '/api/retention', { method: 'PUT', body: JSON.stringify({ operationalDays: 30 }) });
  assert.equal(retention.status, 200);
  const old = new Date(Date.now() - 40 * 86400_000).toISOString();
  await store.update(data => {
    data.sessions.push({ id: 'ses_expired_cleanup', workspaceId: originalWorkspaceId, userId: 'usr_old', expiresAt: old, createdAt: old });
    data.webhookDeliveries.push({ id: 'delivery_cleanup', workspaceId: originalWorkspaceId, status: 'delivered', deliveredAt: old, createdAt: old });
    data.alerts.push({ id: 'alert_cleanup', workspaceId: originalWorkspaceId, sourceKey: 'historical.test', status: 'resolved', resolvedAt: old, createdAt: old });
  });
  const preview = await authRequest(base, '/api/retention/preview');
  assert.equal(preview.body.total, 3);
  assert.deepEqual(preview.body.counts, { sessions: 1, webhookDeliveries: 1, alerts: 1, invitations: 0 });
  assert.equal((await authRequest(base, '/api/retention/cleanup', { method: 'POST', body: JSON.stringify({ asOf: preview.body.asOf, token: 'wrong' }) })).status, 409);
  await store.update(data => { data.sessions.find(item => item.id === 'ses_expired_cleanup').id = 'ses_expired_replaced'; });
  assert.equal((await authRequest(base, '/api/retention/cleanup', { method: 'POST', body: JSON.stringify({ asOf: preview.body.asOf, token: preview.body.token }) })).status, 409);
  const refreshedPreview = await authRequest(base, '/api/retention/preview');
  const cleaned = await authRequest(base, '/api/retention/cleanup', { method: 'POST', body: JSON.stringify({ asOf: refreshedPreview.body.asOf, token: refreshedPreview.body.token }) });
  assert.equal(cleaned.body.total, 3);
  assert.equal((await authRequest(base, '/api/retention/preview')).body.total, 0);

  const auditExport = await authRequest(base, '/api/audit-exports', { method: 'POST' });
  assert.equal(auditExport.status, 201);
  assert.ok(auditExport.body.eventCount > 0);
  const auditDownload = await fetch(`${base}${auditExport.body.downloadUrl}`, { headers: { cookie } });
  assert.equal(auditDownload.status, 200);
  assert.match(auditDownload.headers.get('content-disposition'), /attachment/);
  const auditDocument = await auditDownload.json();
  assert.equal(auditDocument.schema, 'shipwitness.audit-export.v1');
  assert.equal(auditDocument.integrity.valid, true);
  assert.equal(auditDocument.events.length, auditExport.body.eventCount);

  const removed = await authRequest(base, `/api/members/${member.body.membershipId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.revokedApiKeys, 2);
  assert.equal((await resetRequest(base, '/api/session')).status, 401);
  const revokedMachineKey = await request(base, '/api/gates/unknown', { headers: { authorization: `Bearer ${memberKey.body.token}` } });
  assert.equal(revokedMachineKey.status, 401);

  const auditAfterLifecycle = await authRequest(base, '/api/audit');
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'member.role_changed'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'user.password_changed'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'member.password_reset'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'alert.opened'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'alert.acknowledged'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'alert.resolved'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'retention.updated'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'retention.cleaned'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'audit.exported'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'member.removed'));
});

test('browser executor performs a real assertion and records screenshot evidence', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-browser-'));
  let webhookAttempts = 0; let receivedWebhook;
  const server = createApp({ storeFile: join(folder, 'store.json'), signingSecret, webhookRetryBaseMs: 0, webhookUrlValidator: async value => value, webhookSender: async input => { webhookAttempts += 1; if (webhookAttempts === 1) throw new Error('temporary outage'); receivedWebhook = input; return { status: 204 }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await setupOwner(base);
  const authRequest = authenticatedRequest(cookie);

  const webhook = await authRequest(base, '/api/webhooks', { method: 'POST', body: JSON.stringify({ name: '发布通知', url: 'https://hooks.example.test/release', events: ['release.decision'] }) });
  assert.equal(webhook.status, 201);
  assert.match(webhook.body.secret, /^whsec_/);

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

  const approval = await authRequest(base, '/api/decisions', { method: 'POST', body: JSON.stringify({ runId: run.body.id, verdict: 'approve', note: '自动化证据完整' }) });
  assert.equal(approval.status, 201);
  assert.equal(approval.body.verdict, 'approve');
  await server.processWebhookDeliveries();
  let deliveries = await authRequest(base, '/api/webhook-deliveries');
  assert.equal(deliveries.body[0].status, 'retrying');
  await server.processWebhookDeliveries();
  deliveries = await authRequest(base, '/api/webhook-deliveries');
  assert.equal(deliveries.body[0].status, 'delivered');
  assert.equal(deliveries.body[0].attempts, 2);
  assert.equal(receivedWebhook.payload.data.verdict, 'approve');

  const apiKey = await authRequest(base, '/api/api-keys', { method: 'POST', body: JSON.stringify({ name: 'CI 发布门禁', scopes: ['gate:read', 'dossier:read'] }) });
  assert.equal(apiKey.status, 201);
  assert.match(apiKey.body.token, /^swk_/);
  const machineRequest = (path, options = {}) => request(base, path, { ...options, headers: { authorization: `Bearer ${apiKey.body.token}`, ...options.headers } });
  const gate = await machineRequest(`/api/gates/${run.body.id}`);
  assert.equal(gate.status, 200);
  assert.equal(gate.body.status, 'pass');
  assert.equal(gate.body.exitCode, 0);
  const forbiddenMachineSession = await machineRequest('/api/session');
  assert.equal(forbiddenMachineSession.status, 403);

  const signed = await authRequest(base, `/api/dossiers/${run.body.id}/sign`, { method: 'POST' });
  assert.equal(signed.status, 201);
  assert.equal(signed.body.signature.algorithm, 'Ed25519');
  const signedRead = await machineRequest(`/api/signed-dossiers/${signed.body.id}`);
  assert.equal(signedRead.status, 200);
  assert.equal(signedRead.body.valid, true);
  const revoked = await authRequest(base, `/api/api-keys/${apiKey.body.id}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.revokedAt);
  assert.equal((await machineRequest(`/api/gates/${run.body.id}`)).status, 401);
  const disabledWebhook = await authRequest(base, `/api/webhooks/${webhook.body.id}`, { method: 'DELETE' });
  assert.equal(disabledWebhook.status, 200);
  assert.equal(disabledWebhook.body.enabled, false);

  const screenshot = await fetch(`${base}${execution.body.execution.criteriaResults[0].screenshotUrl}`, { headers: { cookie } });
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.headers.get('content-type'), 'image/png');
  assert.equal(screenshot.headers.get('cache-control'), 'no-store');
  assert.ok((await screenshot.arrayBuffer()).byteLength > 1_000);
});
