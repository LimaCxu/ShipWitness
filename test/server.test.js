import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { createApp } from '../server.js';
import { encryptSecret } from '../lib/signing.js';
import { JsonStore } from '../lib/store.js';
import { smtpConfig } from '../lib/email.js';
import { totpCode } from '../lib/mfa.js';

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
const githubWebhookRequest = async (base, secret, { deliveryId, event = 'push', payload, signatureSecret = secret }) => {
  const raw = JSON.stringify(payload); const signature = `sha256=${createHmac('sha256', signatureSecret).update(raw).digest('hex')}`;
  return request(base, '/api/integrations/github/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-delivery': deliveryId, 'x-github-event': event, 'x-hub-signature-256': signature }, body: raw });
};

test('SMTP configuration is disabled by default and rejects partial credentials', () => {
  assert.deepEqual(smtpConfig({}), { enabled: false });
  assert.throws(() => smtpConfig({ SHIPWITNESS_SMTP_HOST: 'smtp.example.com' }), /必须同时设置/);
  assert.throws(() => smtpConfig({ SHIPWITNESS_SMTP_HOST: 'smtp.example.com', SHIPWITNESS_SMTP_FROM: 'notify@example.com', SHIPWITNESS_SMTP_USER: 'user' }), /必须同时配置/);
  assert.equal(smtpConfig({ SHIPWITNESS_SMTP_HOST: 'smtp.example.com', SHIPWITNESS_SMTP_FROM: 'notify@example.com' }).requireTLS, true);
});

test('acceptance credential vault is owner-only and never returns secret material', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-secrets-'));
  const store = new JsonStore(join(folder, 'store.json')); const server = createApp({ store, signingSecret });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const ownerRequest = authenticatedRequest(await setupOwner(base));
  const plaintext = 'customer-password-never-returned';
  const created = await ownerRequest(base, '/api/acceptance-secrets', { method: 'POST', body: JSON.stringify({ name: 'login_password', value: plaintext }) });
  assert.equal(created.status, 201); assert.equal(created.body.name, 'LOGIN_PASSWORD'); assert.ok(new Date(created.body.expiresAt) > new Date());
  assert.equal(JSON.stringify(created.body).includes(plaintext), false); assert.equal(Object.hasOwn(created.body, 'encryptedValue'), false);
  const listed = await ownerRequest(base, '/api/acceptance-secrets'); assert.equal(listed.status, 200); assert.equal(listed.body.length, 1); assert.equal(listed.body[0].referenceCount, 0); assert.equal(listed.body[0].status, 'active'); assert.equal(listed.body[0].daysRemaining, 90);
  assert.equal(JSON.stringify(listed.body).includes(plaintext), false); assert.equal(Object.hasOwn(listed.body[0], 'encryptedValue'), false);
  assert.equal((await ownerRequest(base, '/api/acceptance-secrets', { method: 'POST', body: JSON.stringify({ name: 'LOGIN_PASSWORD', value: 'other' }) })).status, 409);
  assert.equal((await ownerRequest(base, '/api/acceptance-secrets', { method: 'POST', body: JSON.stringify({ name: 'BAD_EXPIRY', value: 'other', expiresInDays: 7 }) })).status, 400);
  await ownerRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '普通成员', email: 'secret-member@example.com', password: 'member-password-123', role: 'member' }) });
  const login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'secret-member@example.com', password: 'member-password-123' }) });
  const memberRequest = authenticatedRequest(login.headers.get('set-cookie').split(';')[0]);
  assert.equal((await memberRequest(base, '/api/acceptance-secrets')).status, 403);
  assert.equal((await memberRequest(base, `/api/acceptance-secrets/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ value: 'forbidden-rotation' }) })).status, 403);
  const project = await ownerRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '凭据验收项目', repo: folder, url: base, branch: 'main' }) });
  const contract = await ownerRequest(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, code: 'AUTH-SECRET', title: '使用保险箱登录', description: '登录密码不得进入合同', steps: [{ action: 'fill', selector: '#password', secretRef: 'LOGIN_PASSWORD' }] }) });
  assert.equal(contract.status, 201); assert.equal((await ownerRequest(base, '/api/acceptance-secrets')).body[0].referenceCount, 1);
  assert.equal((await ownerRequest(base, `/api/acceptance-secrets/${created.body.id}`, { method: 'DELETE' })).status, 409);
  const rotatedPlaintext = 'rotated-customer-password'; const rotated = await ownerRequest(base, `/api/acceptance-secrets/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ value: rotatedPlaintext }) });
  assert.equal(rotated.status, 200); assert.equal(rotated.body.name, 'LOGIN_PASSWORD'); assert.equal(JSON.stringify(rotated.body).includes(rotatedPlaintext), false); assert.equal(Object.hasOwn(rotated.body, 'encryptedValue'), false);
  assert.equal((await ownerRequest(base, `/api/contracts/${contract.body.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).status, 200);
  assert.equal((await ownerRequest(base, `/api/acceptance-secrets/${created.body.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await ownerRequest(base, '/api/acceptance-secrets')).body, []);
  assert.equal((await ownerRequest(base, `/api/contracts/${contract.body.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) })).status, 200);
  const missingContracts = await ownerRequest(base, `/api/contracts?projectId=${project.body.id}`); assert.deepEqual(missingContracts.body[0].missingSecretRefs, ['LOGIN_PASSWORD']);
  const missingPreflight = await ownerRequest(base, `/api/projects/${project.body.id}/preflight`, { method: 'POST' }); assert.equal(missingPreflight.body.checks.credentials.status, 'failed'); assert.deepEqual(missingPreflight.body.checks.credentials.missingSecretRefs, ['LOGIN_PASSWORD']);
  const blockedRun = await ownerRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '验证登录凭据依赖' }) }); assert.equal(blockedRun.status, 409); assert.match(blockedRun.body.error, /LOGIN_PASSWORD/);
  await ownerRequest(base, '/api/acceptance-secrets', { method: 'POST', body: JSON.stringify({ name: 'LOGIN_PASSWORD', value: 'restored-safe-value' }) });
  assert.deepEqual((await ownerRequest(base, `/api/contracts?projectId=${project.body.id}`)).body[0].missingSecretRefs, []); assert.equal((await ownerRequest(base, `/api/projects/${project.body.id}/preflight`, { method: 'POST' })).body.checks.credentials.status, 'ready');
  assert.equal((await ownerRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '验证登录凭据依赖' }) })).status, 201);
  await store.update(data => { data.acceptanceSecrets.find(item => item.name === 'LOGIN_PASSWORD').expiresAt = new Date(Date.now() - 86_400_000).toISOString(); });
  const expiredList = await ownerRequest(base, '/api/acceptance-secrets'); assert.equal(expiredList.body[0].status, 'expired'); assert.equal(expiredList.body[0].daysRemaining, 0);
  const expiredPreflight = await ownerRequest(base, `/api/projects/${project.body.id}/preflight`, { method: 'POST' }); assert.equal(expiredPreflight.body.checks.credentials.status, 'failed'); assert.deepEqual(expiredPreflight.body.checks.credentials.expiredSecretRefs, ['LOGIN_PASSWORD']);
  assert.equal((await ownerRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '过期凭据不得执行' }) })).status, 409);
  const audit = await ownerRequest(base, '/api/audit'); assert.equal(audit.body.some(item => item.action === 'acceptance_secret.rotated'), true); assert.equal(JSON.stringify(audit.body).includes(rotatedPlaintext), false);
});

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
  const setupStatus = await request(base, '/api/setup/status');
  assert.equal(setupStatus.status, 200); assert.equal(setupStatus.body.needsSetup, true); assert.equal(setupStatus.body.deploymentMode, 'controlled_pilot');
  assert.deepEqual(setupStatus.body.checks.map(item => item.id), ['storage', 'master_key', 'public_url', 'email']);
  assert.equal(setupStatus.body.checks.some(item => Object.hasOwn(item, 'secret')), false);
  const frontendScript = await fetch(`${base}/api.js`);
  assert.equal(frontendScript.status, 200);
  assert.equal(frontendScript.headers.get('cache-control'), 'no-cache');
  const frontendScriptText = await frontendScript.text();
  assert.match(frontendScriptText, /创建新任务并重试/);
  assert.match(frontendScriptText, /runProject\.value = backendProject\.name/);
  assert.match(frontendScriptText, /securityFindingDialog/);
  assert.match(frontendScriptText, /account-settings-nav/);
  assert.match(frontendScriptText, /profileForm/);
  assert.match(frontendScriptText, /workspaceIdentityForm/);
  assert.match(frontendScriptText, /feedbackPanel/);
  assert.match(frontendScriptText, /feedbackActionDialog/);
  assert.match(frontendScriptText, /session-management/);
  assert.match(frontendScriptText, /data-revoke-session/);
  assert.match(frontendScriptText, /mfaDialog/);
  assert.match(frontendScriptText, /api\/login\/mfa/);
  assert.match(frontendScriptText, /forgotPassword/);
  assert.match(frontendScriptText, /password-reset\/request/);
  assert.match(frontendScriptText, /setupCheckList/);
  assert.match(frontendScriptText, /继续创建管理员/);
  assert.match(frontendScriptText, /backupSection/);
  assert.match(frontendScriptText, /restore-preflight/);
  assert.match(frontendScriptText, /deploymentConfigurationSection/);
  assert.match(frontendScriptText, /ShipWitness-deployment-/);
  assert.match(frontendScriptText, /shipwitness\.pilot-feedback\.v1|ShipWitness-feedback/);
  assert.match(frontendScriptText, /dataset\.accountAllowed = String\(canAudit\)/);
  assert.match(frontendScriptText, /actionConfirmDialog/);
  assert.doesNotMatch(frontendScriptText, /\bconfirm\(|\bprompt\(|\balert\(/);
  assert.doesNotMatch(frontendScriptText, /prompt\('填写独立复测编号|风险将临时接受 30 天/);
  const frontendShell = await fetch(`${base}/`); const frontendShellText = await frontendShell.text();
  assert.match(frontendShellText, /<body class="auth-pending">/);
  assert.doesNotMatch(frontendShellText, /你的产品决定 · DEL-01/);
  const legacyScript = await fetch(`${base}/app.js`); const legacyScriptText = await legacyScript.text();
  assert.doesNotMatch(legacyScriptText, /浏览器自动执行器正在开发中|shipwitness\.prototype\.connection|模拟执行中/);

  const cookie = await setupOwner(base);
  const authRequest = authenticatedRequest(cookie);
  const initializedSession = await authRequest(base, '/api/session');
  assert.equal(initializedSession.body.workspace.initialization.deploymentMode, 'controlled_pilot');
  assert.equal(initializedSession.body.workspace.initialization.storageEngine, 'json-file');
  assert.equal((await request(base, '/api/setup/status')).body.needsSetup, false);

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

test('project selection persists per user and workspace', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-project-selection-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ownerCookie = await setupOwner(base); const ownerRequest = authenticatedRequest(ownerCookie);
  const first = await ownerRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '项目甲', repo: folder, url: base, branch: 'main' }) });
  const second = await ownerRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '项目乙', repo: folder, url: base, branch: 'develop' }) });
  assert.equal((await ownerRequest(base, '/api/projects')).body.find(item => item.selected).id, second.body.id);
  assert.equal((await ownerRequest(base, `/api/projects/${first.body.id}/select`, { method: 'POST' })).status, 200);
  assert.equal((await ownerRequest(base, '/api/projects')).body.find(item => item.selected).id, first.body.id);

  await ownerRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '项目成员', email: 'project-member@example.com', password: 'member-project-password', role: 'member' }) });
  const memberLogin = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'project-member@example.com', password: 'member-project-password' }) });
  const memberRequest = authenticatedRequest(memberLogin.headers.get('set-cookie').split(';')[0]);
  assert.equal((await memberRequest(base, '/api/projects')).body.find(item => item.selected).id, second.body.id);
  await memberRequest(base, `/api/projects/${second.body.id}/select`, { method: 'POST' });
  assert.equal((await memberRequest(base, '/api/projects')).body.find(item => item.selected).id, second.body.id);
  assert.equal((await ownerRequest(base, '/api/projects')).body.find(item => item.selected).id, first.body.id);

  await ownerRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: first.body.id, requirement: '验证项目甲发布状态', criteria: [] }) });
  const overview = await ownerRequest(base, '/api/projects/overview');
  assert.deepEqual(overview.body.summary, { projects: 2, actionable: 0, inProgress: 1, approved: 0, archived: 0 });
  assert.equal(overview.body.items.find(item => item.id === first.body.id).state, 'queued');
  assert.equal(overview.body.items.find(item => item.id === second.body.id).state, 'not_started');

  const workspace = await ownerRequest(base, '/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '另一个工作区' }) });
  assert.equal(workspace.status, 201);
  assert.equal((await ownerRequest(base, `/api/projects/${first.body.id}/select`, { method: 'POST' })).status, 404);
  assert.equal((await ownerRequest(base, '/api/projects')).body.length, 0);
  assert.deepEqual((await ownerRequest(base, '/api/projects/overview')).body.summary, { projects: 0, actionable: 0, inProgress: 0, approved: 0, archived: 0 });
});

test('GitHub repository sync is role-gated and binds an immutable commit snapshot to each run', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-github-sync-')); let syncCalls = 0;
  const repositoryReader = async input => {
    syncCalls += 1; const sha = String(syncCalls).repeat(40);
    assert.equal(input.repository, 'acme/product'); assert.equal(input.branch, 'main');
    return { provider: 'github', repository: input.repository, branch: input.branch, commit: { sha, shortSha: sha.slice(0, 7), url: `https://github.com/acme/product/commit/${sha}`, message: `Commit ${syncCalls}`, author: 'Ada', committedAt: '2026-08-28T00:00:00Z', verified: true }, checks: { state: 'success', total: 1, passed: 1, failed: 0, pending: 0, detailsUrl: `https://github.com/acme/product/commit/${sha}/checks` }, syncedAt: new Date().toISOString() };
  };
  const server = createApp({ storeFile: join(folder, 'store.json'), githubRepositoryReader: repositoryReader });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const ownerCookie = await setupOwner(base); const ownerRequest = authenticatedRequest(ownerCookie);
  assert.equal((await ownerRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '错误仓库', repo: folder, url: base, branch: 'main', githubRepo: 'https://github.com/acme/product' }) })).status, 400);
  const project = await ownerRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '产品仓库', repo: folder, url: base, branch: 'main', githubRepo: 'acme/product' }) });
  assert.equal(project.status, 201);

  const member = await ownerRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '普通成员', email: 'repo-member@example.com', password: 'member-password-123', role: 'member' }) });
  assert.equal(member.status, 201);
  const login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'repo-member@example.com', password: 'member-password-123' }) });
  const memberRequest = authenticatedRequest(login.headers.get('set-cookie').split(';')[0]);
  assert.equal((await memberRequest(base, `/api/projects/${project.body.id}/repository/sync`, { method: 'POST' })).status, 403);

  const firstSync = await ownerRequest(base, `/api/projects/${project.body.id}/repository/sync`, { method: 'POST' });
  assert.equal(firstSync.status, 200); assert.equal(firstSync.body.commit.sha, '1'.repeat(40));
  const cached = await memberRequest(base, `/api/projects/${project.body.id}/repository`);
  assert.equal(cached.status, 200); assert.equal(cached.body.status.commit.sha, '1'.repeat(40));
  assert.equal(JSON.stringify(cached.body).includes('token'), false);

  const run = await ownerRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '发布候选提交必须可追溯', criteria: [{ code: 'GIT-01', title: '提交绑定', description: '验收记录固定到同步提交' }] }) });
  assert.equal(run.status, 201); assert.equal(run.body.repositorySnapshot.commit.sha, '1'.repeat(40));
  const secondSync = await ownerRequest(base, `/api/projects/${project.body.id}/repository/sync`, { method: 'POST' });
  assert.equal(secondSync.body.commit.sha, '2'.repeat(40));
  const historicalRun = await ownerRequest(base, `/api/runs/${run.body.id}`);
  assert.equal(historicalRun.body.repositorySnapshot.commit.sha, '1'.repeat(40));
  const audit = await ownerRequest(base, '/api/audit');
  assert.equal(audit.body.filter(item => item.action === 'project.repository_synced').length, 2);
});

test('GitHub webhook verifies signatures, rejects replays, syncs matching branches and supports audited retry', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-github-webhook-')); const webhookSecret = 'github-webhook-test-secret'; let calls = 0; let fail = false;
  const repositoryReader = async input => {
    calls += 1; if (fail) throw new Error('GitHub API unavailable'); const sha = String(calls).padStart(40, 'a');
    return { provider: 'github', repository: input.repository, branch: input.branch, commit: { sha, shortSha: sha.slice(0, 7), url: `https://github.com/acme/product/commit/${sha}`, message: 'Webhook sync', author: 'Ada', committedAt: '2026-08-28T00:00:00Z', verified: true }, checks: { state: 'success', total: 1, passed: 1, failed: 0, pending: 0, detailsUrl: `https://github.com/acme/product/commit/${sha}/checks` }, syncedAt: new Date().toISOString() };
  };
  const server = createApp({ storeFile: join(folder, 'store.json'), githubWebhookSecret: webhookSecret, githubRepositoryReader: repositoryReader });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const ownerRequest = authenticatedRequest(cookie);
  const project = await ownerRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Webhook 项目', repo: folder, url: base, branch: 'main', githubRepo: 'acme/product' }) });
  const payload = { ref: 'refs/heads/main', repository: { full_name: 'acme/product' }, after: 'b'.repeat(40) };

  const invalid = await githubWebhookRequest(base, webhookSecret, { deliveryId: 'delivery-invalid', payload, signatureSecret: 'wrong-secret' });
  assert.equal(invalid.status, 401); assert.equal(calls, 0);
  const accepted = await githubWebhookRequest(base, webhookSecret, { deliveryId: 'delivery-1', payload });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.status, 'synced'); assert.equal(calls, 1);
  const duplicate = await githubWebhookRequest(base, webhookSecret, { deliveryId: 'delivery-1', payload });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true); assert.equal(calls, 1);
  const ignored = await githubWebhookRequest(base, webhookSecret, { deliveryId: 'delivery-2', payload: { ...payload, ref: 'refs/heads/other' } });
  assert.equal(ignored.status, 202); assert.equal(ignored.body.status, 'ignored'); assert.equal(calls, 1);

  fail = true;
  const failed = await githubWebhookRequest(base, webhookSecret, { deliveryId: 'delivery-3', event: 'workflow_run', payload: { action: 'completed', repository: { full_name: 'acme/product' }, workflow_run: { head_branch: 'main' } } });
  assert.equal(failed.status, 202); assert.equal(failed.body.status, 'failed');
  const integration = await ownerRequest(base, '/api/integrations/github');
  assert.equal(integration.status, 200); assert.equal(integration.body.configured, true); assert.equal(integration.body.deliveries.length, 3);
  const failedDelivery = integration.body.deliveries.find(item => item.deliveryId === 'delivery-3');
  fail = false;
  const retried = await ownerRequest(base, `/api/github-deliveries/${failedDelivery.id}/retry`, { method: 'POST' });
  assert.equal(retried.status, 200); assert.equal(retried.body.status, 'synced'); assert.equal(retried.body.attempts, 2);
  const repository = await ownerRequest(base, `/api/projects/${project.body.id}/repository`);
  assert.equal(repository.body.status.commit.message, 'Webhook sync');
  const audit = await ownerRequest(base, '/api/audit');
  assert.ok(audit.body.some(item => item.action === 'github.delivery_synced'));
  assert.ok(audit.body.some(item => item.action === 'github.delivery_failed'));
  assert.ok(audit.body.some(item => item.action === 'github.delivery_retried'));
});

test('extension API v1 is scoped, versioned and idempotent for coding agents', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-extension-api-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const ownerRequest = authenticatedRequest(cookie);
  const discovery = await request(base, '/api/v1');
  assert.equal(discovery.status, 200); assert.equal(discovery.body.version, 'v1'); assert.equal(discovery.headers.get('x-shipwitness-api-version'), 'v1');
  const project = await ownerRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Agent 项目', repo: folder, url: base, branch: 'main' }) });
  const key = await ownerRequest(base, '/api/api-keys', { method: 'POST', body: JSON.stringify({ name: 'Coding Agent', scopes: ['acceptance:read', 'acceptance:write', 'dossier:read', 'gate:read'] }) });
  const machine = (path, options = {}) => request(base, path, { ...options, headers: { authorization: `Bearer ${key.body.token}`, ...options.headers } });
  assert.equal((await machine('/api/projects')).status, 403);
  const projects = await machine('/api/v1/projects');
  assert.equal(projects.status, 200); assert.equal(projects.body[0].id, project.body.id); assert.equal(projects.headers.get('x-shipwitness-api-version'), 'v1');
  const payload = JSON.stringify({ projectId: project.body.id, requirement: 'Agent 提交的幂等验收任务', criteria: [] });
  assert.equal((await machine('/api/v1/runs', { method: 'POST', body: payload })).status, 400);
  const headers = { 'idempotency-key': 'agent-run-0001' };
  const first = await machine('/api/v1/runs', { method: 'POST', headers, body: payload });
  assert.equal(first.status, 201);
  const replay = await machine('/api/v1/runs', { method: 'POST', headers, body: payload });
  assert.equal(replay.status, 200); assert.equal(replay.body.id, first.body.id); assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  const conflict = await machine('/api/v1/runs', { method: 'POST', headers, body: JSON.stringify({ projectId: project.body.id, requirement: '不同请求', criteria: [] }) });
  assert.equal(conflict.status, 409);
  const executed = await machine(`/api/v1/runs/${first.body.id}/execute`, { method: 'POST' });
  assert.equal(executed.status, 200); assert.equal(executed.body.status, 'completed');
  const read = await machine(`/api/v1/runs/${first.body.id}`);
  assert.equal(read.status, 200); assert.equal(read.body.id, first.body.id);
  const audit = await ownerRequest(base, '/api/audit');
  assert.equal(audit.body.filter(item => item.action === 'run.created' && item.details.source === 'extension_api_v1').length, 1);
});

test('project archive is reversible, preserves history and protects active work', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-project-archive-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const authRequest = authenticatedRequest(cookie);
  const archivedProject = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '已交付项目', repo: folder, url: base, branch: 'main' }) });
  const activeProject = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '正在开发项目', repo: folder, url: base, branch: 'develop' }) });
  await authRequest(base, `/api/projects/${archivedProject.body.id}/select`, { method: 'POST' });
  const archived = await authRequest(base, `/api/projects/${archivedProject.body.id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: true, reason: '客户已经验收交付' }) });
  assert.equal(archived.status, 200); assert.ok(archived.body.archivedAt);
  const active = (await authRequest(base, '/api/projects')).body;
  assert.equal(active.length, 1); assert.equal(active[0].id, activeProject.body.id); assert.equal(active[0].selected, true);
  const all = (await authRequest(base, '/api/projects?includeArchived=true')).body;
  assert.equal(all.length, 2); assert.equal(all.find(item => item.id === archivedProject.body.id).archiveReason, '客户已经验收交付');
  const overview = await authRequest(base, '/api/projects/overview');
  assert.equal(overview.body.summary.archived, 1); assert.equal(overview.body.archived[0].id, archivedProject.body.id);
  assert.equal((await authRequest(base, `/api/projects/${archivedProject.body.id}/select`, { method: 'POST' })).status, 404);
  assert.equal((await authRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: archivedProject.body.id, requirement: '不应创建', criteria: [] }) })).status, 404);
  assert.equal((await authRequest(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: archivedProject.body.id, code: 'NO-01', title: '不应创建', description: '已归档项目不可写入' }) })).status, 404);

  await authRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: activeProject.body.id, requirement: '仍在排队的任务', criteria: [] }) });
  const blocked = await authRequest(base, `/api/projects/${activeProject.body.id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: true, reason: '暂时停止' }) });
  assert.equal(blocked.status, 409); assert.match(blocked.body.error, /等待或执行中/);
  const restored = await authRequest(base, `/api/projects/${archivedProject.body.id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: false }) });
  assert.equal(restored.status, 200); assert.equal(restored.body.archivedAt, undefined);
  assert.equal((await authRequest(base, '/api/projects')).body.length, 2);
  const audit = await authRequest(base, '/api/audit');
  assert.ok(audit.body.some(item => item.action === 'project.archived' && item.entityId === archivedProject.body.id));
  assert.ok(audit.body.some(item => item.action === 'project.restored' && item.entityId === archivedProject.body.id));

  await authRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '普通成员', email: 'archive-member@example.com', password: 'archive-member-password', role: 'member' }) });
  const login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'archive-member@example.com', password: 'archive-member-password' }) });
  const memberRequest = authenticatedRequest(login.headers.get('set-cookie').split(';')[0]);
  assert.equal((await memberRequest(base, `/api/projects/${archivedProject.body.id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: true, reason: '无权操作' }) })).status, 403);
});

test('contract packs preview conflicts, import safely, export and bulk update', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-contract-pack-'));
  const server = createApp({ storeFile: join(folder, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const authRequest = authenticatedRequest(cookie);
  const source = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '来源项目', repo: folder, url: base, branch: 'main' }) });
  const target = await authRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '目标项目', repo: folder, url: base, branch: 'main' }) });
  for (const contract of [{ code: 'AUTH-01', title: '来源权限标准', description: '普通成员不能访问管理页', category: '权限', severity: 'blocker' }, { code: 'DATA-01', title: '资料持久化', description: '刷新后资料仍然存在', category: '数据', severity: 'major' }]) await authRequest(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: source.body.id, ...contract }) });
  await authRequest(base, '/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: target.body.id, code: 'AUTH-01', title: '目标原标准', description: '保留本项目内容', category: '权限', severity: 'major' }) });

  const exported = await authRequest(base, `/api/contracts/export?projectId=${source.body.id}`);
  assert.equal(exported.body.schema, 'shipwitness.contract-pack.v1');
  assert.equal(exported.body.contracts.length, 2);
  assert.ok(exported.body.contracts.every(item => !('workspaceId' in item) && !('id' in item)));
  const preview = await authRequest(base, '/api/contracts/import/preview', { method: 'POST', body: JSON.stringify({ projectId: target.body.id, sourceProjectId: source.body.id }) });
  assert.deepEqual(preview.body, { total: 2, create: 1, conflicts: ['AUTH-01'] });
  const skipped = await authRequest(base, '/api/contracts/import', { method: 'POST', body: JSON.stringify({ projectId: target.body.id, contracts: exported.body.contracts, conflictMode: 'skip' }) });
  assert.equal(skipped.body.created, 1); assert.equal(skipped.body.skipped, 1);
  let targetContracts = (await authRequest(base, `/api/contracts?projectId=${target.body.id}`)).body;
  assert.equal(targetContracts.find(item => item.code === 'AUTH-01').title, '目标原标准');
  const replaced = await authRequest(base, '/api/contracts/import', { method: 'POST', body: JSON.stringify({ projectId: target.body.id, contracts: exported.body.contracts, conflictMode: 'replace' }) });
  assert.equal(replaced.body.replaced, 2);
  targetContracts = (await authRequest(base, `/api/contracts?projectId=${target.body.id}`)).body;
  assert.equal(targetContracts.find(item => item.code === 'AUTH-01').title, '来源权限标准');
  const bulk = await authRequest(base, '/api/contracts/bulk', { method: 'PATCH', body: JSON.stringify({ projectId: target.body.id, enabled: false }) });
  assert.equal(bulk.body.count, 2);
  assert.ok((await authRequest(base, `/api/contracts?projectId=${target.body.id}`)).body.every(item => item.enabled === false));

  await authRequest(base, '/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '隔离标准空间' }) });
  assert.equal((await authRequest(base, `/api/contracts/export?projectId=${source.body.id}`)).status, 404);
  assert.equal((await authRequest(base, '/api/contracts/import/preview', { method: 'POST', body: JSON.stringify({ projectId: target.body.id, sourceProjectId: source.body.id }) })).status, 404);
});

test('starter kit creates a project, executable contracts and first run atomically', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-starter-'));
  const server = createApp({ storeFile: join(folder, 'store.json'), artifactsDir: join(folder, 'evidence') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const authRequest = authenticatedRequest(cookie);

  const kits = await authRequest(base, '/api/starter-kits');
  assert.equal(kits.status, 200);
  assert.deepEqual(kits.body.map(item => item.id), ['website', 'dashboard', 'login']);
  const invalid = await authRequest(base, '/api/starter-kits/apply', { method: 'POST', body: JSON.stringify({ kitId: 'website', name: '非法路径', repo: folder, url: base, startPath: '//evil.test', expectedText: 'ShipWitness' }) });
  assert.equal(invalid.status, 400);

  const applied = await authRequest(base, '/api/starter-kits/apply', { method: 'POST', body: JSON.stringify({ kitId: 'website', name: '官网验收', repo: folder, url: base, branch: 'main', startPath: '/', expectedText: 'ShipWitness', requirement: '确认官网具备发布基线' }) });
  assert.equal(applied.status, 201);
  assert.equal(applied.body.contracts.length, 2);
  assert.equal(applied.body.run.criteria.length, 2);
  assert.equal(applied.body.run.status, 'queued');
  const projects = (await authRequest(base, '/api/projects')).body;
  assert.equal(projects.length, 1);
  assert.equal(projects[0].selected, true);
  assert.equal((await authRequest(base, `/api/contracts?projectId=${applied.body.project.id}`)).body.length, 2);
  const executed = await authRequest(base, `/api/runs/${applied.body.run.id}/execute`, { method: 'POST' });
  assert.equal(executed.status, 200);
  assert.equal(executed.body.execution.verdict, 'passed');
  const audit = await authRequest(base, '/api/audit');
  assert.ok(audit.body.some(item => item.action === 'starter_kit.applied' && item.entityId === applied.body.project.id));
});

test('team inbox derives actionable work and keeps personal read state', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-inbox-'));
  const server = createApp({ storeFile: join(folder, 'store.json'), artifactsDir: join(folder, 'evidence') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const authRequest = authenticatedRequest(cookie);
  const applied = await authRequest(base, '/api/starter-kits/apply', { method: 'POST', body: JSON.stringify({ kitId: 'website', name: '待办验收', repo: folder, url: base, startPath: '/', expectedText: 'ShipWitness' }) });

  const queued = await authRequest(base, '/api/inbox');
  assert.equal(queued.body.unreadCount, 1);
  assert.equal(queued.body.items[0].key, `run:${applied.body.run.id}:queued`);
  assert.equal((await authRequest(base, '/api/inbox/read', { method: 'POST', body: JSON.stringify({ keys: [queued.body.items[0].key, 'invalid:key'] }) })).body.unreadCount, 0);
  assert.equal((await authRequest(base, '/api/inbox')).body.items[0].unread, false);

  await authRequest(base, `/api/runs/${applied.body.run.id}/execute`, { method: 'POST' });
  const approval = await authRequest(base, '/api/inbox');
  assert.equal(approval.body.unreadCount, 1);
  assert.equal(approval.body.items[0].type, 'approval');
  assert.equal((await authRequest(base, '/api/inbox/read', { method: 'POST', body: JSON.stringify({ all: true }) })).body.unreadCount, 0);
});

test('email queue encrypts invitation links and delivers invitation and approval notices', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-email-')); const storeFile = join(folder, 'store.json'); const sent = []; let failEmail = false;
  const server = createApp({ storeFile, signingSecret, publicUrl: 'https://shipwitness.example', emailRetryBaseMs: 0, emailSender: async message => { if (failEmail) throw new Error('测试 SMTP 不可用'); sent.push(message); return { messageId: `message-${sent.length}` }; }, emailConfiguration: { enabled: true }, artifactsDir: join(folder, 'evidence') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); await server.closeStore(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const deploymentStatus = await request(base, '/api/setup/status'); assert.equal(deploymentStatus.body.deploymentMode, 'public_candidate'); assert.equal(deploymentStatus.body.emailEnabled, true); assert.equal(deploymentStatus.body.publicHttps, true); assert.equal(deploymentStatus.body.masterKeyConfigured, true);
  const cookie = await setupOwner(base); const authRequest = authenticatedRequest(cookie);

  const invitation = await authRequest(base, '/api/invitations', { method: 'POST', body: JSON.stringify({ email: 'mail-invite@example.com', role: 'member' }) });
  assert.equal(invitation.body.emailQueued, true);
  const storedText = JSON.stringify(await new JsonStore(storeFile).read());
  assert.equal(storedText.includes(invitation.body.token), false);
  assert.equal((await authRequest(base, '/api/email/status')).body.counts.queued, 1);
  await server.processEmailDeliveries();
  assert.equal(sent[0].to, 'mail-invite@example.com');
  assert.match(sent[0].text, new RegExp(encodeURIComponent(invitation.body.token)));
  const deliveries = await authRequest(base, '/api/email-deliveries');
  assert.equal(deliveries.body[0].status, 'delivered');
  assert.equal('encryptedMessage' in deliveries.body[0], false);

  const applied = await authRequest(base, '/api/starter-kits/apply', { method: 'POST', body: JSON.stringify({ kitId: 'website', name: '邮件审批项目', repo: folder, url: base, startPath: '/', expectedText: 'ShipWitness' }) });
  await authRequest(base, `/api/runs/${applied.body.run.id}/execute`, { method: 'POST' });
  await server.processEmailDeliveries();
  assert.ok(sent.some(message => message.to === 'owner@example.com' && message.subject.includes('等待发布审批')));

  failEmail = true; const testMail = await authRequest(base, '/api/email/test', { method: 'POST' });
  for (let attempt = 0; attempt < 6; attempt += 1) await server.processEmailDeliveries();
  const failed = (await authRequest(base, '/api/email-deliveries')).body.find(item => item.id === testMail.body.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 6);
  failEmail = false; assert.equal((await authRequest(base, `/api/email-deliveries/${failed.id}/retry`, { method: 'POST' })).status, 202);
  await server.processEmailDeliveries();
  assert.equal((await authRequest(base, '/api/email-deliveries')).body.find(item => item.id === failed.id).status, 'delivered');

  const genericMissing = await request(base, '/api/password-reset/request', { method: 'POST', body: JSON.stringify({ email: 'missing@example.com' }) });
  assert.equal(genericMissing.status, 202); const deliveriesBeforeReset = (await new JsonStore(storeFile).read()).emailDeliveries.length;
  const resetRequested = await request(base, '/api/password-reset/request', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com' }) });
  assert.equal(resetRequested.status, 202); assert.equal(resetRequested.body.message, genericMissing.body.message);
  assert.equal((await new JsonStore(storeFile).read()).emailDeliveries.length, deliveriesBeforeReset + 1);
  await server.processEmailDeliveries(); const resetMessage = sent.findLast(message => message.subject.includes('重置'));
  const resetToken = decodeURIComponent(resetMessage.text.match(/\?reset=([^\s]+)/)[1]);
  const resetDetails = await request(base, `/api/password-reset/${resetToken}`); assert.equal(resetDetails.status, 200); assert.match(resetDetails.body.maskedEmail, /@example\.com$/);
  const resetDone = await request(base, `/api/password-reset/${resetToken}`, { method: 'POST', body: JSON.stringify({ newPassword: 'reset-password-456' }) });
  assert.equal(resetDone.status, 200); assert.ok(resetDone.body.sessionsRevoked >= 1); assert.equal((await authRequest(base, '/api/session')).status, 401);
  assert.equal((await request(base, `/api/password-reset/${resetToken}`)).status, 410);
  assert.equal((await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }) })).status, 401);
  const resetLogin = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'reset-password-456' }) }); assert.equal(resetLogin.status, 200);
  const resetAudit = await authenticatedRequest(resetLogin.headers.get('set-cookie').split(';')[0])(base, '/api/audit');
  assert.ok(resetAudit.body.some(item => item.action === 'user.password_reset_requested')); assert.ok(resetAudit.body.some(item => item.action === 'user.password_reset_completed'));
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

test('pilot feedback is workspace-scoped, role-managed, auditable and exportable', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-feedback-'));
  const server = createApp({ storeFile: join(folder, 'store.json'), browserRunExecutor: async ({ run }) => ({ executor: 'test-browser', verdict: 'passed', summary: '来源标准真实断言通过', criteriaResults: run.criteria.map((item, index) => ({ id: `criterion-${index + 1}`, title: item.title, result: 'passed', reason: '测试断言通过' })) }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ownerCookie = await setupOwner(base); const ownerRequest = authenticatedRequest(ownerCookie);
  const ownerSession = await ownerRequest(base, '/api/session'); const originalWorkspaceId = ownerSession.body.workspace.id;
  const project = await ownerRequest(base, '/api/projects', { method: 'POST', body: JSON.stringify({ name: '试点项目', repo: folder, url: `${base}/`, branch: 'main' }) });
  const member = await ownerRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '试点成员', email: 'pilot@example.com', password: 'pilot-member-password', role: 'member' }) });
  assert.equal(member.status, 201);
  const login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'pilot@example.com', password: 'pilot-member-password' }) });
  const memberRequest = authenticatedRequest(login.headers.get('set-cookie').split(';')[0]);
  assert.equal((await memberRequest(base, '/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'pilot-member-password', newPassword: 'pilot-member-password-new' }) })).status, 200);

  const created = await memberRequest(base, '/api/feedback', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, kind: 'usability', severity: 'high', title: '第一次使用找不到反馈入口', description: '希望在顶部提供稳定入口，并能看到处理状态。' }) });
  assert.equal(created.status, 201); assert.equal(created.body.status, 'new');
  assert.equal((await memberRequest(base, `/api/feedback/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) })).status, 403);
  assert.equal((await memberRequest(base, `/api/feedback/${created.body.id}/promote`, { method: 'POST', body: JSON.stringify({ expectedResult: '提供明确反馈入口' }) })).status, 403);
  assert.equal((await memberRequest(base, '/api/feedback/export')).status, 403);

  const inbox = await ownerRequest(base, '/api/inbox');
  assert.ok(inbox.body.items.some(item => item.action.kind === 'feedback' && item.action.id === created.body.id));
  const listed = await ownerRequest(base, '/api/feedback?status=new');
  assert.equal(listed.body.length, 1); assert.equal(listed.body[0].reporter.name, '试点成员'); assert.equal(listed.body[0].project.name, '试点项目');
  assert.equal((await ownerRequest(base, `/api/feedback/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'triaged', note: '确认需要纳入验收' }) })).body.status, 'triaged');
  const promoted = await ownerRequest(base, `/api/feedback/${created.body.id}/promote`, { method: 'POST', body: JSON.stringify({ title: '反馈入口清晰可见', expectedResult: '登录后顶部必须显示可操作的反馈入口。' }) });
  assert.equal(promoted.status, 201); assert.equal(promoted.body.feedback.status, 'planned'); assert.equal(promoted.body.contract.enabled, false); assert.equal(promoted.body.contract.sourceFeedbackId, created.body.id);
  assert.equal((await ownerRequest(base, `/api/feedback/${created.body.id}/promote`, { method: 'POST', body: JSON.stringify({ expectedResult: '不得重复' }) })).status, 409);
  const contracts = await ownerRequest(base, `/api/contracts?projectId=${project.body.id}`);
  assert.equal(contracts.body.filter(item => item.sourceFeedbackId === created.body.id).length, 1);
  assert.equal((await ownerRequest(base, `/api/feedback/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) })).status, 400);
  const spoofed = await ownerRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '调用方不能伪造反馈来源', criteria: [{ contractId: promoted.body.contract.id, sourceFeedbackId: created.body.id, code: 'FAKE-01', title: '伪造来源', description: '不应关闭反馈', steps: [{ action: 'expectText', selector: 'body', value: 'ShipWitness' }] }] }) });
  assert.equal(spoofed.body.criteria[0].sourceFeedbackId, undefined);
  await ownerRequest(base, `/api/runs/${spoofed.body.id}/execute`, { method: 'POST' });
  assert.equal((await ownerRequest(base, '/api/feedback?status=planned')).body[0].id, created.body.id);
  const enabled = await ownerRequest(base, `/api/contracts/${promoted.body.contract.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: true, steps: [{ action: 'goto', path: '/' }, { action: 'expectText', selector: 'body', value: 'ShipWitness' }] }) });
  assert.equal(enabled.body.enabled, true);
  const run = await ownerRequest(base, '/api/runs', { method: 'POST', body: JSON.stringify({ projectId: project.body.id, requirement: '验证反馈修复已经达到正确结果', criteria: [] }) });
  assert.equal(run.body.criteria[0].sourceFeedbackId, created.body.id);
  const executed = await ownerRequest(base, `/api/runs/${run.body.id}/execute`, { method: 'POST' });
  assert.equal(executed.body.execution.criteriaResults[0].result, 'passed');
  const verified = await ownerRequest(base, '/api/feedback?status=resolved');
  assert.equal(verified.body[0].id, created.body.id); assert.equal(verified.body[0].verification.runId, run.body.id); assert.equal(verified.body[0].verification.contractVersion, enabled.body.version);
  assert.equal((await ownerRequest(base, `/api/feedback/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'planned', note: '直接改回' }) })).status, 409);
  assert.equal((await ownerRequest(base, `/api/feedback/${created.body.id}/reopen`, { method: 'POST', body: JSON.stringify({ reason: '' }) })).status, 400);
  const reopened = await ownerRequest(base, `/api/feedback/${created.body.id}/reopen`, { method: 'POST', body: JSON.stringify({ reason: '试点成员报告相同问题再次出现' }) });
  assert.equal(reopened.body.status, 'planned'); assert.equal(reopened.body.verification, undefined); assert.equal(reopened.body.verificationHistory.length, 1); assert.equal(reopened.body.verificationHistory[0].runId, run.body.id);
  const retry = await ownerRequest(base, `/api/runs/${run.body.id}/retry`, { method: 'POST' });
  await ownerRequest(base, `/api/runs/${retry.body.id}/execute`, { method: 'POST' });
  const reverified = await ownerRequest(base, '/api/feedback?status=resolved');
  assert.equal(reverified.body[0].verification.runId, retry.body.id); assert.equal(reverified.body[0].verificationHistory.length, 1);
  const exported = await ownerRequest(base, '/api/feedback/export');
  assert.equal(exported.body.schema, 'shipwitness.pilot-feedback.v1'); assert.equal(exported.body.items.length, 1); assert.match(exported.headers.get('content-disposition'), /attachment/);

  const secondWorkspace = await ownerRequest(base, '/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '隔离试点' }) });
  assert.equal(secondWorkspace.status, 201); assert.equal((await ownerRequest(base, '/api/feedback')).body.length, 0);
  await ownerRequest(base, `/api/workspaces/${originalWorkspaceId}/select`, { method: 'POST' });
  const audit = await ownerRequest(base, '/api/audit');
  assert.ok(audit.body.some(item => item.action === 'feedback.created'));
  assert.ok(audit.body.some(item => item.action === 'feedback.promoted'));
  assert.ok(audit.body.some(item => item.action === 'feedback.status_changed'));
  assert.ok(audit.body.some(item => item.action === 'feedback.reopened'));
  assert.ok(audit.body.some(item => item.action === 'feedback.verified_by_run'));
  assert.ok(audit.body.some(item => item.action === 'feedback.exported'));
});

test('readiness report is owner-only, conservative and never exposes configuration secrets', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-readiness-local-'));
  const invalidSecret = 'not-a-production-key';
  const server = createApp({ storeFile: join(folder, 'store.json'), signingSecret: invalidSecret, publicUrl: 'http://127.0.0.1:4173' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ownerCookie = await setupOwner(base);
  const ownerRequest = authenticatedRequest(ownerCookie);

  const report = await ownerRequest(base, '/api/readiness');
  assert.equal(report.status, 200);
  assert.equal(report.body.schema, 'shipwitness.readiness.v1');
  assert.equal(report.body.verdict.level, 'local_only');
  assert.ok(report.body.verdict.blockers >= 3);
  assert.equal(report.body.checks.find(item => item.id === 'postgres').status, 'block');
  assert.equal(report.body.checks.find(item => item.id === 'https').status, 'block');
  assert.equal(report.body.checks.find(item => item.id === 'master_key').status, 'block');
  assert.equal(report.body.checks.find(item => item.id === 'privileged_mfa').status, 'warning');
  assert.equal(report.body.checks.find(item => item.id === 'support_lifecycle').status, 'warning');
  assert.match(report.body.checks.find(item => item.id === 'audit').detail, /^1 条审计事件哈希链完整。$/);
  assert.equal(JSON.stringify(report.body).includes(invalidSecret), false);

  const member = await ownerRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '普通成员', email: 'readiness-member@example.com', password: 'member-password-123', role: 'member' }) });
  assert.equal(member.status, 201);
  const login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'readiness-member@example.com', password: 'member-password-123' }) });
  const memberRequest = authenticatedRequest(login.headers.get('set-cookie').split(';')[0]);
  assert.equal((await memberRequest(base, '/api/readiness')).status, 403);
});

test('readiness report recognizes a fully configured production candidate', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-readiness-production-'));
  const store = new JsonStore(join(folder, 'store.json'));
  store.health = async () => ({ status: 'ready', engine: 'PostgreSQL 16.15' });
  const server = createApp({
    store,
    signingSecret,
    publicUrl: 'https://shipwitness.example',
    allowedTargetOrigins: ['https://staging.example'],
    lastVerifiedBackupAt: new Date().toISOString(),
    securityReviewReference: 'independent-review-2026-08',
    securityReviewedAt: new Date().toISOString(),
    version: '1.0.0',
    releasedAt: '2026-08-01T00:00:00Z',
    endOfSupportAt: '2027-08-01T00:00:00Z',
    emailSender: async () => ({ messageId: 'test-message' }),
    emailConfiguration: { enabled: true }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await setupOwner(base);
  await store.update(data => { data.users[0].mfaSecretEncrypted = 'readiness-evidence-present'; data.recoveryDrills.push({ id: 'rdr_ready', workspaceId: data.workspaces[0].id, backupId: 'backup-ready', status: 'passed', completedAt: new Date().toISOString(), counts: { workspaces: 1, projects: 1, runs: 1, auditEvents: 1 } }); });

  const report = await authenticatedRequest(cookie)(base, '/api/readiness');
  assert.equal(report.status, 200);
  assert.equal(report.body.verdict.level, 'production_candidate');
  assert.equal(report.body.verdict.blockers, 0);
  assert.equal(report.body.verdict.warnings, 0);
  assert.ok(report.body.checks.every(item => item.status === 'pass'));
  const support = await request(base, '/api/support');
  assert.equal(support.status, 200); assert.equal(support.body.schema, 'shipwitness.support-policy.v1'); assert.equal(support.body.currentRelease.status, 'supported');
});

test('security review findings block release until retested or explicitly time-bound', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-security-review-')); const store = new JsonStore(join(folder, 'store.json')); const server = createApp({ store, signingSecret });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const ownerRequest = authenticatedRequest(cookie);
  const review = await ownerRequest(base, '/api/security/reviews', { method: 'POST', body: JSON.stringify({ provider: 'Independent Security Lab', reference: 'PENTEST-2026-001', reviewedAt: new Date().toISOString(), scope: 'Web application, API, authentication and deployment boundary', summary: 'One high-risk authorization finding requires remediation.', findings: [{ severity: 'high', title: 'Authorization bypass', description: 'A crafted request could bypass one project boundary.', remediation: 'Apply workspace filter before lookup.' }] }) });
  assert.equal(review.status, 201); assert.equal(review.body.findings.length, 1);
  let readiness = await ownerRequest(base, '/api/readiness');
  assert.equal(readiness.body.checks.find(item => item.id === 'security_review').status, 'pass');
  assert.equal(readiness.body.checks.find(item => item.id === 'security_findings').status, 'block');
  const findingId = review.body.findings[0].id; const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  const accepted = await ownerRequest(base, `/api/security/findings/${findingId}`, { method: 'PATCH', body: JSON.stringify({ status: 'risk_accepted', rationale: 'Temporary pilot-only mitigation with network allowlist.', expiresAt }) });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.status, 'risk_accepted');
  readiness = await ownerRequest(base, '/api/readiness'); assert.equal(readiness.body.checks.find(item => item.id === 'security_findings').status, 'warning');
  await store.update(data => { const finding = data.securityFindings.find(item => item.id === findingId); finding.riskAcceptance.expiresAt = new Date(Date.now() - 60_000).toISOString(); finding.updatedAt = new Date().toISOString(); });
  readiness = await ownerRequest(base, '/api/readiness'); assert.equal(readiness.body.checks.find(item => item.id === 'security_findings').status, 'block');
  const expiredAcceptanceDossier = await ownerRequest(base, `/api/security/reviews/${review.body.id}/sign`, { method: 'POST' });
  assert.equal(expiredAcceptanceDossier.body.payload.summary.riskAccepted, 0); assert.equal(expiredAcceptanceDossier.body.payload.summary.expiredRiskAcceptances, 1); assert.equal(expiredAcceptanceDossier.body.payload.summary.unresolved, 1);
  const verified = await ownerRequest(base, `/api/security/findings/${findingId}`, { method: 'PATCH', body: JSON.stringify({ status: 'verified', evidence: 'Independent retest PENTEST-2026-001-R1 confirms the bypass is closed.' }) });
  assert.equal(verified.status, 200); assert.match(verified.body.retestEvidence, /R1/);
  readiness = await ownerRequest(base, '/api/readiness'); assert.equal(readiness.body.checks.find(item => item.id === 'security_findings').status, 'pass'); assert.equal(readiness.body.checks.find(item => item.id === 'security_evidence').status, 'warning');
  const signed = await ownerRequest(base, `/api/security/reviews/${review.body.id}/sign`, { method: 'POST' });
  assert.equal(signed.status, 201); assert.equal(signed.body.schema, 'shipwitness.signed-security-review.v1'); assert.equal(signed.body.valid, true); assert.equal(signed.body.payload.summary.verified, 1);
  const downloaded = await ownerRequest(base, `/api/security-review-dossiers/${signed.body.id}`); assert.equal(downloaded.status, 200); assert.equal(downloaded.body.valid, true);
  readiness = await ownerRequest(base, '/api/readiness'); assert.equal(readiness.body.checks.find(item => item.id === 'security_evidence').status, 'pass');
  const reviews = await ownerRequest(base, '/api/security/reviews'); assert.equal(reviews.body[0].findings[0].status, 'verified'); assert.equal(reviews.body[0].dossier.current, true);
  const audit = await ownerRequest(base, '/api/audit'); assert.equal(audit.body.filter(item => item.action === 'security.finding_status_changed').length, 2);
  assert.equal(audit.body.filter(item => item.action === 'security.review_signed').length, 2);
});

test('two-step verification protects login, consumes recovery codes and revokes other sessions', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-mfa-'));
  const server = createApp({ storeFile: join(folder, 'store.json'), signingSecret });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const cookie = await setupOwner(base); const ownerRequest = authenticatedRequest(cookie);
  assert.deepEqual((await ownerRequest(base, '/api/account/mfa')).body, { enabled: false, enabledAt: null, recoveryCodesRemaining: 0 });
  assert.equal((await ownerRequest(base, '/api/account/mfa/setup', { method: 'POST', body: JSON.stringify({ currentPassword: 'wrong-password' }) })).status, 400);
  const setup = await ownerRequest(base, '/api/account/mfa/setup', { method: 'POST', body: JSON.stringify({ currentPassword: 'correct-horse-battery' }) });
  assert.equal(setup.status, 200); assert.match(setup.body.secret, /^[A-Z2-7]+$/); assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal((await ownerRequest(base, '/api/account/mfa/enable', { method: 'POST', body: JSON.stringify({ code: '000000' }) })).status, 400);
  const enabled = await ownerRequest(base, '/api/account/mfa/enable', { method: 'POST', body: JSON.stringify({ code: totpCode(setup.body.secret) }) });
  assert.equal(enabled.status, 200); assert.equal(enabled.body.recoveryCodes.length, 10); assert.equal((await ownerRequest(base, '/api/account/mfa')).body.enabled, true);
  const invitationToken = 'mfa-invitation-token'; const mfaStore = new JsonStore(join(folder, 'store.json')); const invitationExpiry = new Date(Date.now() + 3600_000).toISOString();
  await mfaStore.update(data => { data.workspaces.push({ id: 'ws_mfa_invite', name: 'MFA 邀请工作区', createdAt: new Date().toISOString() }); data.invitations.push({ id: 'inv_mfa', workspaceId: 'ws_mfa_invite', email: 'owner@example.com', role: 'approver', tokenHash: createHash('sha256').update(invitationToken).digest('hex'), expiresAt: invitationExpiry, createdAt: new Date().toISOString() }); });
  const invitationPassword = await request(base, `/api/invitations/${invitationToken}`, { method: 'POST', body: JSON.stringify({ password: 'correct-horse-battery' }) });
  assert.equal(invitationPassword.status, 202); assert.equal(invitationPassword.body.mfaRequired, true);
  const invitationVerified = await request(base, '/api/login/mfa', { method: 'POST', body: JSON.stringify({ challengeToken: invitationPassword.body.challengeToken, code: totpCode(setup.body.secret) }) });
  assert.equal(invitationVerified.status, 200); assert.equal(invitationVerified.body.workspace.id, 'ws_mfa_invite'); assert.equal(invitationVerified.body.role, 'approver');
  const passwordLogin = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }) });
  assert.equal(passwordLogin.status, 202); assert.equal(passwordLogin.body.mfaRequired, true); assert.equal(passwordLogin.headers.get('set-cookie'), null);
  assert.equal((await request(base, '/api/login/mfa', { method: 'POST', body: JSON.stringify({ challengeToken: passwordLogin.body.challengeToken, code: '111111' }) })).status, 401);
  const verifiedLogin = await request(base, '/api/login/mfa', { method: 'POST', body: JSON.stringify({ challengeToken: passwordLogin.body.challengeToken, code: totpCode(setup.body.secret) }) });
  assert.equal(verifiedLogin.status, 200); const secondCookie = verifiedLogin.headers.get('set-cookie').split(';')[0];
  const recoveryLogin = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }) });
  const recovered = await request(base, '/api/login/mfa', { method: 'POST', body: JSON.stringify({ challengeToken: recoveryLogin.body.challengeToken, code: enabled.body.recoveryCodes[0] }) });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.recoveryCodesRemaining, 9);
  const disabled = await authenticatedRequest(secondCookie)(base, '/api/account/mfa/disable', { method: 'POST', body: JSON.stringify({ currentPassword: 'correct-horse-battery', code: enabled.body.recoveryCodes[1] }) });
  assert.equal(disabled.status, 200); assert.ok(disabled.body.sessionsRevoked >= 2);
  assert.equal((await ownerRequest(base, '/api/session')).status, 401);
  assert.equal((await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'correct-horse-battery' }) })).status, 200);
  const store = new JsonStore(join(folder, 'store.json')); const audit = (await store.read()).auditEvents;
  assert.ok(audit.some(item => item.action === 'user.mfa_enabled')); assert.ok(audit.some(item => item.action === 'user.mfa_disabled'));
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

  const renamedWorkspace = await authRequest(base, `/api/workspaces/${originalWorkspaceId}`, { method: 'PATCH', body: JSON.stringify({ name: '正式验收工作区' }) });
  assert.equal(renamedWorkspace.status, 200);
  assert.equal(renamedWorkspace.body.name, '正式验收工作区');
  const updatedProfile = await authRequest(base, '/api/account/profile', { method: 'PATCH', body: JSON.stringify({ name: '验收负责人' }) });
  assert.equal(updatedProfile.status, 200);
  assert.equal(updatedProfile.body.name, '验收负责人');
  const identitySession = await authRequest(base, '/api/session');
  assert.equal(identitySession.body.workspace.name, '正式验收工作区');
  assert.equal(identitySession.body.user.name, '验收负责人');

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
  const forbiddenRename = await authenticatedRequest(memberCookie)(base, `/api/workspaces/${originalWorkspaceId}`, { method: 'PATCH', body: JSON.stringify({ name: '越权改名' }) });
  assert.equal(forbiddenRename.status, 403);
  const forbiddenDecision = await authenticatedRequest(memberCookie)(base, '/api/decisions', { method: 'POST', body: JSON.stringify({ runId: 'run_unknown', owner: '普通成员', verdict: 'pass' }) });
  assert.equal(forbiddenDecision.status, 403);

  const promoted = await authRequest(base, `/api/members/${member.body.membershipId}`, { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.role, 'owner');
  const memberOwnerRequest = authenticatedRequest(memberCookie);
  const memberKey = await memberOwnerRequest(base, '/api/api-keys', { method: 'POST', body: JSON.stringify({ name: '即将撤销的 Key', scopes: ['gate:read'] }) });
  assert.equal(memberKey.status, 201);

  const secondLogin = await request(base, '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'ShipWitness-Test-Secondary/1.0' }, body: JSON.stringify({ email: 'member@example.com', password: 'member-password-123' }) });
  const secondMemberCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  const memberSessions = await memberOwnerRequest(base, '/api/account/sessions');
  assert.equal(memberSessions.status, 200);
  assert.equal(memberSessions.body.length, 2);
  assert.equal(memberSessions.body.filter(item => item.current).length, 1);
  const secondarySession = memberSessions.body.find(item => item.userAgent === 'ShipWitness-Test-Secondary/1.0');
  assert.ok(secondarySession);
  const currentSessionRecord = memberSessions.body.find(item => item.current);
  assert.equal((await memberOwnerRequest(base, `/api/account/sessions/${currentSessionRecord.id}/revoke`, { method: 'POST' })).status, 409);
  const revokedSession = await memberOwnerRequest(base, `/api/account/sessions/${secondarySession.id}/revoke`, { method: 'POST' });
  assert.equal(revokedSession.status, 200);
  assert.equal((await authenticatedRequest(secondMemberCookie)(base, '/api/session')).status, 401);
  assert.equal((await memberOwnerRequest(base, '/api/account/sessions')).body.length, 1);
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
    data.githubDeliveries.push({ id: 'github_delivery_cleanup', deliveryId: 'old-delivery', workspaceIds: [originalWorkspaceId], status: 'synced', receivedAt: old, updatedAt: old });
    data.alerts.push({ id: 'alert_cleanup', workspaceId: originalWorkspaceId, sourceKey: 'historical.test', status: 'resolved', resolvedAt: old, createdAt: old });
  });
  const preview = await authRequest(base, '/api/retention/preview');
  assert.equal(preview.body.total, 4);
  assert.deepEqual(preview.body.counts, { sessions: 1, webhookDeliveries: 1, emailDeliveries: 0, githubDeliveries: 1, idempotencyRecords: 0, alerts: 1, invitations: 0 });
  assert.equal((await authRequest(base, '/api/retention/cleanup', { method: 'POST', body: JSON.stringify({ asOf: preview.body.asOf, token: 'wrong' }) })).status, 409);
  await store.update(data => { data.sessions.find(item => item.id === 'ses_expired_cleanup').id = 'ses_expired_replaced'; });
  assert.equal((await authRequest(base, '/api/retention/cleanup', { method: 'POST', body: JSON.stringify({ asOf: preview.body.asOf, token: preview.body.token }) })).status, 409);
  const refreshedPreview = await authRequest(base, '/api/retention/preview');
  const cleaned = await authRequest(base, '/api/retention/cleanup', { method: 'POST', body: JSON.stringify({ asOf: refreshedPreview.body.asOf, token: refreshedPreview.body.token }) });
  assert.equal(cleaned.body.total, 4);
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
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'workspace.renamed'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'user.profile_updated'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'user.password_changed'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'user.session_revoked'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'member.password_reset'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'alert.opened'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'alert.acknowledged'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'alert.resolved'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'retention.updated'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'retention.cleaned'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'audit.exported'));
  assert.ok(auditAfterLifecycle.body.some(item => item.action === 'member.removed'));
});

test('owners can suspend access, force sign-out and reset single-workspace MFA safely', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-member-security-'));
  const storeFile = join(folder, 'store.json'); const server = createApp({ storeFile, signingSecret });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const ownerCookie = await setupOwner(base); const ownerRequest = authenticatedRequest(ownerCookie);
  const member = await ownerRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '安全成员', email: 'security-member@example.com', password: 'security-member-password', role: 'member' }) });
  let login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'security-member@example.com', password: 'security-member-password' }) });
  let memberRequest = authenticatedRequest(login.headers.get('set-cookie').split(';')[0]);
  const listed = await ownerRequest(base, '/api/members'); const listedMember = listed.body.find(item => item.id === member.body.id);
  assert.equal(listedMember.activeSessions, 1); assert.equal(listedMember.disabledAt, null);

  const forced = await ownerRequest(base, `/api/members/${member.body.membershipId}/sessions/revoke`, { method: 'POST' });
  assert.equal(forced.status, 200); assert.equal(forced.body.sessionsRevoked, 1); assert.equal((await memberRequest(base, '/api/session')).status, 401);
  login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'security-member@example.com', password: 'security-member-password' }) }); memberRequest = authenticatedRequest(login.headers.get('set-cookie').split(';')[0]);
  const disabled = await ownerRequest(base, `/api/members/${member.body.membershipId}/disable`, { method: 'POST' });
  assert.equal(disabled.status, 200); assert.equal(disabled.body.sessionsRevoked, 1); assert.ok(disabled.body.disabledAt); assert.equal((await memberRequest(base, '/api/session')).status, 401);
  assert.equal((await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'security-member@example.com', password: 'security-member-password' }) })).status, 403);
  const enabled = await ownerRequest(base, `/api/members/${member.body.membershipId}/enable`, { method: 'POST' }); assert.equal(enabled.status, 200); assert.equal(enabled.body.disabledAt, null);

  const store = new JsonStore(storeFile); await store.update(data => { const user = data.users.find(item => item.id === member.body.id); user.mfaSecretEncrypted = encryptSecret('JBSWY3DPEHPK3PXP', signingSecret); user.mfaRecoveryCodeHashes = ['unused']; user.mfaEnabledAt = new Date().toISOString(); });
  const mfaReset = await ownerRequest(base, `/api/members/${member.body.membershipId}/mfa/reset`, { method: 'POST' }); assert.equal(mfaReset.status, 200); assert.equal(mfaReset.body.mfaEnabled, false);
  const afterReset = await store.read(); assert.equal(Boolean(afterReset.users.find(item => item.id === member.body.id).mfaSecretEncrypted), false);
  const audit = await ownerRequest(base, '/api/audit');
  for (const action of ['member.sessions_revoked', 'member.disabled', 'member.enabled', 'member.mfa_reset']) assert.ok(audit.body.some(item => item.action === action));
});

test('backup center creates, verifies and preflights restore without mutating live data', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-backup-center-')); const now = new Date().toISOString();
  const backupManager = {
    available: true,
    drillAvailable: true,
    list: async () => [{ id: '2026-08-28T10-00-00-000Z', createdAt: now, applicationVersion: '0.4.0-dev.41', schemaVersion: 16, evidenceFiles: 3 }],
    create: async () => ({ id: '2026-08-28T10-00-00-000Z', createdAt: now, applicationVersion: '0.4.0-dev.41', schemaVersion: 16, evidenceFiles: 3 }),
    verify: async id => ({ id, valid: true, verifiedAt: new Date().toISOString(), filesVerified: 4, createdAt: now, applicationVersion: '0.4.0-dev.41', schemaVersion: 16 }),
    restorePreflight: async id => ({ id, valid: true, verifiedAt: new Date().toISOString(), filesVerified: 4, createdAt: now, applicationVersion: '0.4.0-dev.41', schemaVersion: 16, schemaCompatible: true, canRestore: true, requiresMaintenanceMode: true, command: `SHIPWITNESS_RESTORE_CONFIRM=YES npm run restore -- /safe/${id}`, warning: '恢复会覆盖目标数据库。' }),
    drill: async id => ({ backupId: id, status: 'passed', startedAt: now, completedAt: new Date().toISOString(), durationMs: 321, applicationVersion: '0.4.0-dev.43', schemaVersion: 17, filesVerified: 4, counts: { workspaces: 1, projects: 2, runs: 3, auditEvents: 4 }, isolation: { targetValidated: true, databaseNameRedacted: true } })
  };
  const server = createApp({ storeFile: join(folder, 'store.json'), signingSecret, backupManager }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const ownerCookie = await setupOwner(base); const ownerRequest = authenticatedRequest(ownerCookie);
  const listed = await ownerRequest(base, '/api/backups'); assert.equal(listed.status, 200); assert.equal(listed.body.items.length, 1); assert.equal(listed.body.verifiedBackupAt, null);
  const created = await ownerRequest(base, '/api/backups', { method: 'POST' }); assert.equal(created.status, 201);
  const verified = await ownerRequest(base, `/api/backups/${created.body.id}/verify`, { method: 'POST' }); assert.equal(verified.body.filesVerified, 4);
  const badConfirmation = await ownerRequest(base, `/api/backups/${created.body.id}/restore-preflight`, { method: 'POST', body: JSON.stringify({ confirmation: '错误确认' }) }); assert.equal(badConfirmation.status, 400);
  const preflight = await ownerRequest(base, `/api/backups/${created.body.id}/restore-preflight`, { method: 'POST', body: JSON.stringify({ confirmation: `预检恢复 ${created.body.id}` }) }); assert.equal(preflight.status, 200); assert.equal(preflight.body.canRestore, true); assert.equal(preflight.body.requiresMaintenanceMode, true);
  const badDrill = await ownerRequest(base, `/api/backups/${created.body.id}/drill`, { method: 'POST', body: JSON.stringify({ confirmation: '错误确认' }) }); assert.equal(badDrill.status, 400);
  const drill = await ownerRequest(base, `/api/backups/${created.body.id}/drill`, { method: 'POST', body: JSON.stringify({ confirmation: `演练恢复 ${created.body.id}` }) }); assert.equal(drill.status, 201); assert.equal(drill.body.status, 'passed'); assert.equal(drill.body.counts.runs, 3);
  const afterDrill = await ownerRequest(base, '/api/backups'); assert.equal(afterDrill.body.drills.length, 1); assert.equal(afterDrill.body.drills[0].isolation.databaseNameRedacted, true);
  const readiness = await ownerRequest(base, '/api/readiness'); assert.equal(readiness.body.checks.find(item => item.id === 'backup').status, 'pass');
  assert.equal(readiness.body.checks.find(item => item.id === 'recovery_drill').status, 'pass');
  const audit = await ownerRequest(base, '/api/audit'); for (const action of ['backup.created', 'backup.verified', 'backup.restore_preflighted', 'backup.recovery_drilled']) assert.ok(audit.body.some(item => item.action === action));
  const member = await ownerRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '普通成员', email: 'backup-member@example.com', password: 'backup-member-password', role: 'member' }) }); assert.equal(member.status, 201);
  const login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'backup-member@example.com', password: 'backup-member-password' }) }); const memberRequest = authenticatedRequest(login.headers.get('set-cookie').split(';')[0]); assert.equal((await memberRequest(base, '/api/backups')).status, 403);
});

test('deployment configuration is owner-only and exports status without secret values', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'shipwitness-deployment-config-')); const store = new JsonStore(join(folder, 'store.json'));
  store.health = async () => ({ status: 'ready', engine: 'PostgreSQL 16.15' });
  const secrets = { database: 'postgresql://secret-user:database-password@db.internal/shipwitness', github: 'github-signing-secret', smtpHost: 'smtp.private.internal', smtpUser: 'smtp-private-user', smtpPassword: 'smtp-private-password', publicHost: 'private.shipwitness.example', backupPath: join(folder, 'customer-backups'), target: 'https://customer-private.example', review: 'PEN-SECRET-2026' };
  const backupManager = { available: true, list: async () => [], create: async () => {}, verify: async () => {}, restorePreflight: async () => {} };
  const server = createApp({ store, databaseUrl: secrets.database, signingSecret, githubWebhookSecret: secrets.github, publicUrl: `https://${secrets.publicHost}`, allowedTargetOrigins: [secrets.target], lastVerifiedBackupAt: new Date().toISOString(), securityReviewReference: secrets.review, securityReviewedAt: new Date().toISOString(), backupRoot: secrets.backupPath, backupManager, emailConfiguration: { enabled: true, host: secrets.smtpHost, from: 'private@example.com', requireTLS: true, auth: { user: secrets.smtpUser, pass: secrets.smtpPassword } }, emailSender: async () => ({ messageId: 'test' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const ownerCookie = await setupOwner(base); const ownerRequest = authenticatedRequest(ownerCookie);
  const report = await ownerRequest(base, '/api/deployment/configuration'); assert.equal(report.status, 200); assert.equal(report.body.schema, 'shipwitness.deployment-configuration.v1'); assert.equal(report.body.verdict.blockers, 0); assert.equal(report.body.items.length, 8); assert.ok(report.body.items.every(item => Array.isArray(item.requiredVariables)));
  const serialized = JSON.stringify(report.body); for (const secret of Object.values(secrets)) assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes(signingSecret), false); assert.match(serialized, /SHIPWITNESS_MASTER_KEY/); assert.match(serialized, /DATABASE_URL/);
  const member = await ownerRequest(base, '/api/members', { method: 'POST', body: JSON.stringify({ name: '交付成员', email: 'delivery-member@example.com', password: 'delivery-member-password', role: 'member' }) }); assert.equal(member.status, 201);
  const login = await request(base, '/api/login', { method: 'POST', body: JSON.stringify({ email: 'delivery-member@example.com', password: 'delivery-member-password' }) }); const memberRequest = authenticatedRequest(login.headers.get('set-cookie').split(';')[0]); assert.equal((await memberRequest(base, '/api/deployment/configuration')).status, 403);
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
