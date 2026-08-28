import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { JsonStore, createId } from './lib/store.js';
import { PostgresStore } from './lib/postgres-store.js';
import { appendAudit, verifyAuditChain } from './lib/audit.js';
import { buildHandoffPackage, createGitHubIssue } from './lib/handoff.js';
import { evaluateReleaseGate } from './lib/release-gate.js';
import { createSigningKey, decryptSecret, encryptSecret, signPayload, verifySignedPayload } from './lib/signing.js';
import { sendWebhook, validateWebhookUrl } from './lib/webhook.js';
import { fetchTarget, targetOrigins, validateTargetUrl } from './lib/target-policy.js';
import { checkBrowserAvailability, executeBrowserRun, normalizeSteps } from './lib/browser-executor.js';
import { clearSessionCookie, createSessionToken, hashPassword, readSessionToken, sessionCookie, verifyPassword } from './lib/auth.js';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'outputs/shipwitness-prototype');
const defaultStore = process.env.SHIPWITNESS_STORE_FILE || join(root, 'data/store.json');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const serviceVersion = '0.4.0-dev.7';
const securityHeaders = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin'
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const body = async req => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }); }
};

const required = (value, field, maxLength = 5000) => {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${field}不能为空`), { status: 400 });
  if (value.trim().length > maxLength) throw Object.assign(new Error(`${field}长度不能超过 ${maxLength} 个字符`), { status: 400 });
  return value.trim();
};

const normalizedEmail = value => {
  const email = required(value, '邮箱', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('邮箱格式无效'), { status: 400 });
  return email;
};

const publicUser = user => ({ id: user.id, email: user.email, name: user.name, createdAt: user.createdAt });
const sessionTokenHash = token => createHash('sha256').update(String(token || '')).digest('hex');
const dossierPayload = (data, run, workspaceId) => {
  const auditEvents = data.auditEvents.filter(item => item.workspaceId === workspaceId);
  return { schema: 'shipwitness.dossier.v2', workspaceId, run, issues: data.issues.filter(item => item.workspaceId === workspaceId && item.runId === run.id), decisions: data.decisions.filter(item => item.workspaceId === workspaceId && item.runId === run.id), auditProof: verifyAuditChain(auditEvents) };
};

async function checkRepository(repoPath) {
  try {
    const info = await stat(repoPath);
    if (!info.isDirectory()) return { status: 'failed', detail: '路径不是目录' };
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--short', 'HEAD'], { timeout: 3000 });
      return { status: 'ready', detail: `Git 提交 ${stdout.trim()}` };
    } catch { return { status: 'warning', detail: '目录可读取，但不是 Git 仓库' }; }
  } catch { return { status: 'failed', detail: '目录不存在或无权读取' }; }
}

async function checkUrl(url, allowedOrigins) {
  try {
    const response = await fetchTarget(url, { allowedOrigins, timeoutMs: 3500 });
    return response.status < 500 ? { status: 'ready', detail: `HTTP ${response.status}` } : { status: 'failed', detail: `HTTP ${response.status}` };
  } catch { return { status: 'failed', detail: '网址当前无法访问' }; }
}

async function inspectTarget(url, allowedOrigins) {
  const started = Date.now();
  try {
    const response = await fetchTarget(url, { allowedOrigins, timeoutMs: 5000 });
    const contentType = response.headers.get('content-type') || 'unknown';
    const text = (await response.text()).slice(0, 250_000);
    const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null;
    return { status: response.status < 500 ? 'ready' : 'failed', httpStatus: response.status, finalUrl: response.url, contentType, title, durationMs: Date.now() - started, bodyBytesInspected: Buffer.byteLength(text), contentSha256: createHash('sha256').update(text).digest('hex') };
  } catch (error) {
    return { status: 'failed', error: error.name === 'TimeoutError' ? '请求超时' : '目标不可访问', durationMs: Date.now() - started };
  }
}

async function executeRun(project, run, allowedOrigins) {
  const [repository, target] = await Promise.all([checkRepository(project.repo), inspectTarget(project.url, allowedOrigins)]);
  const canContinue = repository.status !== 'failed' && target.status === 'ready';
  return {
    executor: 'shipwitness-basic-v1',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    repository,
    target,
    systemChecks: [
      { id: 'repository-readable', label: '项目目录可读取', result: repository.status },
      { id: 'target-reachable', label: '测试网址可访问', result: target.status }
    ],
    criteriaResults: run.criteria.map((criterion, index) => ({ id: `criterion-${index + 1}`, title: criterion.title, description: criterion.description, result: canContinue ? 'evidence_insufficient' : 'blocked', reason: canContinue ? '基础执行器只能证明环境可访问，尚未执行真实浏览器业务路径。' : '基础环境检查未通过，无法进入业务路径。' })),
    verdict: canContinue ? 'evidence_insufficient' : 'blocked',
    summary: canContinue ? '基础环境证据已收集；业务验收仍需浏览器执行器。' : '基础环境未通过，验收被阻断。'
  };
}

export function createApp({ storeFile = defaultStore, databaseUrl = process.env.DATABASE_URL, store: providedStore, githubIssueCreator = createGitHubIssue, signingSecret = process.env.SHIPWITNESS_MASTER_KEY, webhookSender = sendWebhook, webhookUrlValidator = validateWebhookUrl, webhookRetryBaseMs = 60_000, allowedTargetOrigins = targetOrigins(), browserRunExecutor = executeBrowserRun, basicRunExecutor = executeRun } = {}) {
  const store = providedStore || (databaseUrl ? new PostgresStore(databaseUrl) : new JsonStore(storeFile));
  const artifactsDir = process.env.SHIPWITNESS_ARTIFACTS_DIR || join(dirname(storeFile), 'evidence');
  const loginAttempts = new Map();
  const processWebhookDeliveries = async () => {
    const snapshot = await store.read(); const now = new Date();
    const due = snapshot.webhookDeliveries.filter(item => (['queued', 'retrying'].includes(item.status) && new Date(item.nextAttemptAt) <= now) || (item.status === 'sending' && new Date(item.lastAttemptAt || 0) <= new Date(now.getTime() - 5 * 60_000))).slice(0, 10);
    for (const candidate of due) {
      const claimed = await store.update(data => {
        const delivery = data.webhookDeliveries.find(item => item.id === candidate.id);
        const staleSending = delivery?.status === 'sending' && new Date(delivery.lastAttemptAt || 0) <= new Date(Date.now() - 5 * 60_000);
        if (!delivery || (!['queued', 'retrying'].includes(delivery.status) && !staleSending) || (!staleSending && new Date(delivery.nextAttemptAt) > new Date())) return null;
        const webhook = data.webhooks.find(item => item.id === delivery.webhookId && item.enabled);
        if (!webhook) { delivery.status = 'cancelled'; return null; }
        delivery.status = 'sending'; delivery.attempts += 1; delivery.lastAttemptAt = new Date().toISOString(); return { delivery: { ...delivery }, webhook: { ...webhook } };
      });
      if (!claimed) continue;
      try {
        const response = await webhookSender({ url: claimed.webhook.url, secret: decryptSecret(claimed.webhook.encryptedSecret, signingSecret), event: claimed.delivery.event, deliveryId: claimed.delivery.id, payload: claimed.delivery.payload });
        await store.update(data => { const delivery = data.webhookDeliveries.find(item => item.id === claimed.delivery.id); delivery.status = 'delivered'; delivery.deliveredAt = new Date().toISOString(); delivery.responseStatus = response.status; appendAudit(data, { workspaceId: delivery.workspaceId, action: 'webhook.delivered', entityType: 'webhook_delivery', entityId: delivery.id, details: { event: delivery.event, attempts: delivery.attempts }, at: delivery.deliveredAt }); });
      } catch (error) {
        await store.update(data => { const delivery = data.webhookDeliveries.find(item => item.id === claimed.delivery.id); delivery.lastError = String(error.message || '投递失败').slice(0, 300); delivery.status = delivery.attempts >= 6 ? 'failed' : 'retrying'; delivery.nextAttemptAt = new Date(Date.now() + Math.min(webhookRetryBaseMs * 2 ** (delivery.attempts - 1), 3_600_000)).toISOString(); if (delivery.status === 'failed') appendAudit(data, { workspaceId: delivery.workspaceId, action: 'webhook.failed', entityType: 'webhook_delivery', entityId: delivery.id, details: { event: delivery.event, attempts: delivery.attempts, error: delivery.lastError } }); });
      }
    }
    return due.length;
  };
  const webhookTimer = setInterval(() => processWebhookDeliveries().catch(() => undefined), 10_000); webhookTimer.unref();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);
      const secureCookie = req.headers['x-forwarded-proto'] === 'https';

      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
        const expectedOrigin = `${secureCookie ? 'https' : 'http'}://${req.headers.host}`;
        if (req.headers.origin !== expectedOrigin) return json(res, 403, { error: '请求来源无效' });
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        try { return json(res, 200, { ok: true, service: 'shipwitness', version: serviceVersion, uptimeSeconds: Math.round(process.uptime()), storage: await store.health() }); }
        catch { return json(res, 503, { ok: false, service: 'shipwitness', version: serviceVersion, error: '存储当前不可用' }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/setup/status') {
        const data = await store.read();
        return json(res, 200, { needsSetup: !data.users.length });
      }
      if (req.method === 'POST' && url.pathname === '/api/setup') {
        const input = await body(req);
        const passwordHash = await hashPassword(input.password);
        const created = await store.update(data => {
          if (data.users.length) throw Object.assign(new Error('系统已经完成初始化'), { status: 409 });
          const now = new Date().toISOString();
          const workspace = { id: createId('ws'), name: required(input.workspaceName || '默认工作区', '工作区名称'), createdAt: now };
          const user = { id: createId('usr'), email: normalizedEmail(input.email), name: required(input.name || '管理员', '姓名'), passwordHash, createdAt: now };
          const membership = { id: createId('mem'), workspaceId: workspace.id, userId: user.id, role: 'owner', createdAt: now };
          const token = createSessionToken();
          const session = { id: createId('ses'), tokenHash: sessionTokenHash(token), userId: user.id, workspaceId: workspace.id, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), createdAt: now };
          data.workspaces.push(workspace); data.users.push(user); data.memberships.push(membership); data.sessions.push(session);
          for (const collection of ['projects', 'contracts', 'runs', 'issues', 'decisions']) for (const item of data[collection]) item.workspaceId ||= workspace.id;
          appendAudit(data, { workspaceId: workspace.id, actorUserId: user.id, action: 'workspace.initialized', entityType: 'workspace', entityId: workspace.id, details: { migratedCollections: ['projects', 'contracts', 'runs', 'issues', 'decisions'] }, at: now });
          return { user, workspace, membership, token };
        });
        return json(res, 201, { user: publicUser(created.user), workspace: created.workspace, role: created.membership.role }, { 'set-cookie': sessionCookie(created.token, { secure: secureCookie }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const input = await body(req); const email = normalizedEmail(input.email); const attemptKey = `${req.socket.remoteAddress}:${email}`; const nowMs = Date.now();
        const attempt = loginAttempts.get(attemptKey); if (attempt && attempt.count >= 5 && nowMs - attempt.startedAt < 15 * 60_000) return json(res, 429, { error: '登录尝试过多，请 15 分钟后重试' });
        const data = await store.read();
        const user = data.users.find(item => item.email === email);
        if (!user || !await verifyPassword(input.password, user.passwordHash)) { loginAttempts.set(attemptKey, { count: (attempt?.count || 0) + 1, startedAt: attempt?.startedAt || nowMs }); return json(res, 401, { error: '邮箱或密码错误' }); }
        loginAttempts.delete(attemptKey);
        const membership = data.memberships.find(item => item.userId === user.id);
        if (!membership) return json(res, 403, { error: '账号尚未加入工作区' });
        const token = createSessionToken(); const now = new Date().toISOString();
        await store.update(current => { current.sessions = current.sessions.filter(item => new Date(item.expiresAt) > new Date()); current.sessions.push({ id: createId('ses'), tokenHash: sessionTokenHash(token), userId: user.id, workspaceId: membership.workspaceId, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), createdAt: now }); appendAudit(current, { workspaceId: membership.workspaceId, actorUserId: user.id, action: 'user.login', entityType: 'user', entityId: user.id, at: now }); });
        const workspace = data.workspaces.find(item => item.id === membership.workspaceId);
        return json(res, 200, { user: publicUser(user), workspace, role: membership.role }, { 'set-cookie': sessionCookie(token, { secure: secureCookie }) });
      }

      const authData = await store.read();
      const cookieToken = readSessionToken(req.headers.cookie);
      const cookieTokenHash = sessionTokenHash(cookieToken);
      const session = authData.sessions.find(item => item.tokenHash === cookieTokenHash && new Date(item.expiresAt) > new Date());
      const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
      const apiKey = bearer && authData.apiKeys.find(item => item.tokenHash === sessionTokenHash(bearer) && !item.revokedAt);
      const actorUserId = session?.userId || apiKey?.createdByUserId;
      const workspaceId = session?.workspaceId || apiKey?.workspaceId;
      const currentUser = actorUserId && authData.users.find(item => item.id === actorUserId);
      const currentWorkspace = workspaceId && authData.workspaces.find(item => item.id === workspaceId);
      const membership = currentUser && authData.memberships.find(item => item.userId === currentUser.id && item.workspaceId === workspaceId);
      if (url.pathname.startsWith('/api/') && !session && !apiKey) return json(res, 401, { error: '请先登录或提供 API Key' });
      if (apiKey) {
        const allowed = req.method === 'GET' && ((url.pathname.startsWith('/api/gates/') && apiKey.scopes.includes('gate:read')) || (url.pathname.startsWith('/api/dossiers/') && apiKey.scopes.includes('dossier:read')) || (url.pathname.startsWith('/api/signed-dossiers/') && apiKey.scopes.includes('dossier:read')));
        if (!allowed) return json(res, 403, { error: 'API Key 作用域不足' });
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        if (!session) return json(res, 403, { error: 'API Key 不能读取交互会话' });
        return json(res, 200, { user: publicUser(currentUser), workspace: currentWorkspace, role: membership?.role });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        await store.update(data => { data.sessions = data.sessions.filter(item => item.tokenHash !== cookieTokenHash); appendAudit(data, { workspaceId: session.workspaceId, actorUserId: currentUser.id, action: 'user.logout', entityType: 'user', entityId: currentUser.id }); });
        return json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(secureCookie) });
      }

      const requireRole = roles => {
        if (!membership || !roles.includes(membership.role)) throw Object.assign(new Error('当前角色无权执行此操作'), { status: 403 });
      };
      if (req.method === 'GET' && url.pathname === '/api/workspaces') {
        const ids = authData.memberships.filter(item => item.userId === currentUser.id).map(item => item.workspaceId);
        return json(res, 200, authData.workspaces.filter(item => ids.includes(item.id)).map(item => ({ ...item, current: item.id === workspaceId })));
      }
      if (req.method === 'POST' && url.pathname === '/api/workspaces') {
        const input = await body(req); const now = new Date().toISOString();
        const workspace = await store.update(data => {
          const value = { id: createId('ws'), name: required(input.name, '工作区名称'), createdAt: now };
          data.workspaces.push(value); data.memberships.push({ id: createId('mem'), workspaceId: value.id, userId: currentUser.id, role: 'owner', createdAt: now });
          const active = data.sessions.find(item => item.tokenHash === cookieTokenHash); active.workspaceId = value.id;
          appendAudit(data, { workspaceId: value.id, actorUserId: currentUser.id, action: 'workspace.created', entityType: 'workspace', entityId: value.id, at: now });
          return value;
        });
        return json(res, 201, workspace);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'workspaces' && segments[2] && segments[3] === 'select') {
        const targetMembership = authData.memberships.find(item => item.userId === currentUser.id && item.workspaceId === segments[2]);
        if (!targetMembership) return json(res, 404, { error: '工作区不存在' });
        await store.update(data => { data.sessions.find(item => item.tokenHash === cookieTokenHash).workspaceId = targetMembership.workspaceId; appendAudit(data, { workspaceId: targetMembership.workspaceId, actorUserId: currentUser.id, action: 'workspace.selected', entityType: 'workspace', entityId: targetMembership.workspaceId }); });
        return json(res, 200, { workspace: authData.workspaces.find(item => item.id === targetMembership.workspaceId), role: targetMembership.role });
      }
      if (req.method === 'GET' && url.pathname === '/api/members') {
        const members = authData.memberships.filter(item => item.workspaceId === workspaceId).map(item => ({ ...publicUser(authData.users.find(user => user.id === item.userId)), role: item.role, membershipId: item.id }));
        return json(res, 200, members);
      }
      if (req.method === 'POST' && url.pathname === '/api/members') {
        requireRole(['owner']);
        const input = await body(req); const email = normalizedEmail(input.email); const role = input.role || 'member';
        if (!['owner', 'approver', 'member'].includes(role)) return json(res, 400, { error: '成员角色无效' });
        const passwordHash = await hashPassword(input.password);
        const member = await store.update(data => {
          let user = data.users.find(item => item.email === email); const now = new Date().toISOString();
          if (!user) { user = { id: createId('usr'), email, name: required(input.name, '姓名'), passwordHash, createdAt: now }; data.users.push(user); }
          if (data.memberships.some(item => item.workspaceId === workspaceId && item.userId === user.id)) throw Object.assign(new Error('该用户已经是工作区成员'), { status: 409 });
          const item = { id: createId('mem'), workspaceId, userId: user.id, role, createdAt: now }; data.memberships.push(item); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'member.added', entityType: 'membership', entityId: item.id, details: { userId: user.id, role }, at: now }); return { ...publicUser(user), role, membershipId: item.id };
        });
        return json(res, 201, member);
      }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        requireRole(['owner', 'approver']);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 200);
        const events = authData.auditEvents.filter(item => item.workspaceId === workspaceId).sort((a, b) => b.sequence - a.sequence).slice(0, limit).map(item => ({ ...item, actor: item.actorUserId ? publicUser(authData.users.find(user => user.id === item.actorUserId) || { id: item.actorUserId, name: '未知用户', email: '' }) : null }));
        return json(res, 200, events);
      }
      if (req.method === 'GET' && url.pathname === '/api/audit/verify') {
        requireRole(['owner', 'approver']);
        return json(res, 200, verifyAuditChain(authData.auditEvents.filter(item => item.workspaceId === workspaceId)));
      }
      if (req.method === 'GET' && url.pathname === '/api/api-keys') {
        requireRole(['owner']);
        return json(res, 200, authData.apiKeys.filter(item => item.workspaceId === workspaceId).map(({ tokenHash: hidden, ...item }) => item));
      }
      if (req.method === 'POST' && url.pathname === '/api/api-keys') {
        requireRole(['owner']);
        const input = await body(req); const scopes = Array.isArray(input.scopes) ? [...new Set(input.scopes)] : ['gate:read']; const allowedScopes = ['gate:read', 'dossier:read'];
        if (!scopes.length || scopes.some(scope => !allowedScopes.includes(scope))) return json(res, 400, { error: 'API Key 作用域无效' });
        const secret = `swk_${randomBytes(32).toString('base64url')}`; const now = new Date().toISOString();
        const created = await store.update(data => {
          const item = { id: createId('key'), workspaceId, name: required(input.name, '名称'), tokenHash: sessionTokenHash(secret), tokenSuffix: secret.slice(-6), scopes, createdByUserId: currentUser.id, createdAt: now, lastUsedAt: null, revokedAt: null };
          data.apiKeys.unshift(item); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'api_key.created', entityType: 'api_key', entityId: item.id, details: { name: item.name, scopes }, at: now }); return item;
        });
        const { tokenHash: hidden, ...safe } = created;
        return json(res, 201, { ...safe, token: secret });
      }
      if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'api-keys' && segments[2]) {
        requireRole(['owner']);
        const revoked = await store.update(data => {
          const item = data.apiKeys.find(key => key.id === segments[2] && key.workspaceId === workspaceId);
          if (!item) throw Object.assign(new Error('API Key 不存在'), { status: 404 });
          if (!item.revokedAt) {
            item.revokedAt = new Date().toISOString();
            appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'api_key.revoked', entityType: 'api_key', entityId: item.id, details: { name: item.name }, at: item.revokedAt });
          }
          return item;
        });
        return json(res, 200, { id: revoked.id, revokedAt: revoked.revokedAt });
      }
      if (req.method === 'GET' && url.pathname === '/api/webhooks') {
        requireRole(['owner']);
        return json(res, 200, authData.webhooks.filter(item => item.workspaceId === workspaceId).map(({ encryptedSecret: hidden, ...item }) => item));
      }
      if (req.method === 'POST' && url.pathname === '/api/webhooks') {
        requireRole(['owner']);
        const input = await body(req); const events = Array.isArray(input.events) ? [...new Set(input.events)] : ['release.decision']; const allowedEvents = ['release.decision'];
        if (!events.length || events.some(event => !allowedEvents.includes(event))) return json(res, 400, { error: 'Webhook 事件无效' });
        const webhookUrl = await webhookUrlValidator(required(input.url, 'Webhook URL')); const secret = `whsec_${randomBytes(32).toString('base64url')}`; const now = new Date().toISOString();
        const created = await store.update(data => { const item = { id: createId('wh'), workspaceId, name: required(input.name, '名称'), url: webhookUrl, events, encryptedSecret: encryptSecret(secret, signingSecret), enabled: true, createdByUserId: currentUser.id, createdAt: now }; data.webhooks.unshift(item); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'webhook.created', entityType: 'webhook', entityId: item.id, details: { name: item.name, events }, at: now }); return item; });
        const { encryptedSecret: hidden, ...safe } = created; return json(res, 201, { ...safe, secret });
      }
      if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'webhooks' && segments[2]) {
        requireRole(['owner']);
        const disabled = await store.update(data => {
          const item = data.webhooks.find(webhook => webhook.id === segments[2] && webhook.workspaceId === workspaceId);
          if (!item) throw Object.assign(new Error('Webhook 不存在'), { status: 404 });
          if (item.enabled) {
            item.enabled = false; item.disabledAt = new Date().toISOString();
            appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'webhook.disabled', entityType: 'webhook', entityId: item.id, details: { name: item.name }, at: item.disabledAt });
          }
          return item;
        });
        return json(res, 200, { id: disabled.id, enabled: disabled.enabled, disabledAt: disabled.disabledAt });
      }
      if (req.method === 'GET' && url.pathname === '/api/webhook-deliveries') {
        requireRole(['owner']);
        return json(res, 200, authData.webhookDeliveries.filter(item => item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100));
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, (await store.read()).projects.filter(item => item.workspaceId === workspaceId));
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(req); const repoPath = required(input.repo, '项目目录', 4096); const targetUrl = validateTargetUrl(required(input.url, '测试网址', 2048), allowedTargetOrigins).href;
        const project = await store.update(data => {
          const now = new Date().toISOString();
          const existing = data.projects.find(item => item.id === input.id && item.workspaceId === workspaceId);
          const value = { id: existing?.id || createId('prj'), workspaceId, name: required(input.name || '未命名项目', '项目名称'), repo: repoPath, url: targetUrl, branch: required(input.branch || 'main', '代码分支', 255), handoffMode: input.handoffMode || 'file', githubRepo: String(input.githubRepo || existing?.githubRepo || '').trim(), updatedAt: now, createdAt: existing?.createdAt || now };
          existing ? Object.assign(existing, value) : data.projects.push(value);
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: existing ? 'project.updated' : 'project.created', entityType: 'project', entityId: value.id, details: { branch: value.branch, handoffMode: value.handoffMode }, at: now });
          return value;
        });
        return json(res, 201, project);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'preflight') {
        const data = await store.read();
        const project = data.projects.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!project) return json(res, 404, { error: '项目不存在' });
        const [repo, target, browserRuntime] = await Promise.all([checkRepository(project.repo), checkUrl(project.url, allowedTargetOrigins), checkBrowserAvailability()]);
        const checks = { repo, url: target, browser: target.status === 'ready' ? browserRuntime : { status: 'blocked', detail: '测试网址不可用' }, handoff: project.handoffMode === 'agent' ? { status: 'warning', detail: '编码 AI 连接器尚未配置' } : { status: 'ready', detail: project.handoffMode === 'file' ? '保存为本地返工单' : '复制任务文本' } };
        return json(res, 200, { projectId: project.id, checkedAt: new Date().toISOString(), checks });
      }
      if (req.method === 'GET' && url.pathname === '/api/contracts') {
        const data = await store.read();
        const contracts = (data.contracts || []).filter(item => item.workspaceId === workspaceId && (!url.searchParams.get('projectId') || item.projectId === url.searchParams.get('projectId')));
        contracts.sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt.localeCompare(a.updatedAt));
        return json(res, 200, contracts);
      }
      if (req.method === 'POST' && url.pathname === '/api/contracts') {
        const input = await body(req);
        const contract = await store.update(data => {
          data.contracts ||= [];
          if (!data.projects.some(item => item.id === input.projectId && item.workspaceId === workspaceId)) throw Object.assign(new Error('项目不存在'), { status: 404 });
          const code = required(input.code, '标准编号').toUpperCase();
          if (data.contracts.some(item => item.projectId === input.projectId && item.code === code)) throw Object.assign(new Error('标准编号已存在'), { status: 409 });
          const now = new Date().toISOString();
          const value = { id: createId('ctr'), workspaceId, projectId: input.projectId, code, title: required(input.title, '标准名称'), description: required(input.description, '标准描述'), category: input.category || '业务流程', severity: input.severity || 'blocker', steps: normalizeSteps(input.steps), enabled: input.enabled !== false, version: 1, createdAt: now, updatedAt: now };
          data.contracts.unshift(value); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'contract.created', entityType: 'contract', entityId: value.id, details: { code: value.code, version: value.version }, at: now });
          return value;
        });
        return json(res, 201, contract);
      }
      if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'contracts' && segments[2]) {
        const input = await body(req);
        const contract = await store.update(data => {
          data.contracts ||= [];
          const current = data.contracts.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!current) throw Object.assign(new Error('验收标准不存在'), { status: 404 });
          if ('title' in input) current.title = required(input.title, '标准名称');
          if ('description' in input) current.description = required(input.description, '标准描述');
          if ('category' in input) current.category = required(input.category, '标准分类');
          if ('severity' in input) current.severity = required(input.severity, '严重级别');
          if ('steps' in input) current.steps = normalizeSteps(input.steps);
          if ('enabled' in input) current.enabled = Boolean(input.enabled);
          current.version += 1;
          current.updatedAt = new Date().toISOString();
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'contract.updated', entityType: 'contract', entityId: current.id, details: { code: current.code, version: current.version, enabled: current.enabled }, at: current.updatedAt });
          return current;
        });
        return json(res, 200, contract);
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, (await store.read()).runs.filter(item => item.workspaceId === workspaceId));
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'runs' && segments[2] && segments.length === 3) {
        const data = await store.read();
        const run = data.runs.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        return run ? json(res, 200, run) : json(res, 404, { error: '验收记录不存在' });
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const input = await body(req);
        const run = await store.update(data => {
          if (!data.projects.some(item => item.id === input.projectId && item.workspaceId === workspaceId)) throw Object.assign(new Error('项目不存在'), { status: 404 });
          data.contracts ||= [];
          const supplied = Array.isArray(input.criteria) ? input.criteria : [];
          const criteria = supplied.length ? supplied.map(item => ({ ...item, steps: normalizeSteps(item.steps) })) : data.contracts.filter(item => item.workspaceId === workspaceId && item.projectId === input.projectId && item.enabled).map(item => ({ contractId: item.id, code: item.code, title: item.title, description: item.description, category: item.category, severity: item.severity, steps: normalizeSteps(item.steps), version: item.version }));
          const value = { id: createId('run'), workspaceId, projectId: input.projectId, requirement: required(input.requirement, '原始需求'), criteria, status: 'queued', createdAt: new Date().toISOString() };
          data.runs.unshift(value); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'run.created', entityType: 'run', entityId: value.id, details: { criteriaCount: criteria.length }, at: value.createdAt }); return value;
        });
        return json(res, 201, run);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'runs' && segments[2] && segments[3] === 'execute') {
        const snapshot = await store.read();
        const run = snapshot.runs.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!run) return json(res, 404, { error: '验收记录不存在' });
        const project = snapshot.projects.find(item => item.id === run.projectId && item.workspaceId === workspaceId);
        if (!project) return json(res, 409, { error: '任务关联的项目不存在' });
        validateTargetUrl(project.url, allowedTargetOrigins);
        await store.update(data => { const current = data.runs.find(item => item.id === run.id); const stale = current.status === 'running' && new Date(current.startedAt || 0) <= new Date(Date.now() - 15 * 60_000); if (current.status === 'running' && !stale) throw Object.assign(new Error('任务正在执行'), { status: 409 }); current.status = 'running'; current.startedAt = new Date().toISOString(); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: stale ? 'run.recovered' : 'run.started', entityType: 'run', entityId: current.id, at: current.startedAt }); });
        try {
          const hasBrowserSteps = run.criteria.some(item => Array.isArray(item.steps) && item.steps.length);
          const execution = hasBrowserSteps ? await browserRunExecutor({ project, run, artifactsDir, allowedOrigins: allowedTargetOrigins }) : await basicRunExecutor(project, run, allowedTargetOrigins);
          const completed = await store.update(data => {
            const current = data.runs.find(item => item.id === run.id);
            current.status = 'completed'; current.execution = execution; current.completedAt = new Date().toISOString();
            for (const issueId of current.issueIds || []) {
              const issue = data.issues.find(item => item.id === issueId);
              if (!issue) continue;
              issue.status = execution.verdict === 'passed' ? 'verified' : 'handed_off';
              issue.updatedAt = current.completedAt;
              issue.timeline ||= [];
              issue.timeline.push({ status: issue.status, at: current.completedAt, note: execution.verdict === 'passed' ? '定向复验通过' : `定向复验未通过：${execution.summary}` });
            }
            appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'run.completed', entityType: 'run', entityId: current.id, details: { verdict: execution.verdict, executor: execution.executor }, at: current.completedAt });
            return current;
          });
          return json(res, 200, completed);
        } catch (error) {
          await store.update(data => { const current = data.runs.find(item => item.id === run.id); current.status = 'failed'; current.failure = '执行器发生内部错误'; appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'run.failed', entityType: 'run', entityId: current.id, details: { failure: current.failure } }); });
          throw error;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/issues') {
        const input = await body(req);
        const issue = await store.update(data => {
          const run = data.runs.find(item => item.id === input.runId && item.workspaceId === workspaceId);
          if (!run) throw Object.assign(new Error('验收记录不存在'), { status: 404 });
          const criterion = input.criterionId ? run.criteria.find(item => (item.contractId || item.code) === input.criterionId) : null;
          const result = criterion && run.execution?.criteriaResults?.find(item => item.title === criterion.title);
          if (input.criterionId && !criterion) throw Object.assign(new Error('验收标准不属于该任务'), { status: 400 });
          if (result?.result === 'passed') throw Object.assign(new Error('通过项不能创建返工单'), { status: 409 });
          const duplicate = data.issues.find(item => item.runId === run.id && item.criterionId === input.criterionId && !['verified', 'closed'].includes(item.status));
          if (duplicate) throw Object.assign(new Error('该失败项已有未关闭的返工单'), { status: 409 });
          const now = new Date().toISOString();
          const value = {
            id: createId('issue'), workspaceId, runId: run.id, projectId: run.projectId,
            criterionId: input.criterionId || null, code: criterion?.code || input.code || 'ISSUE',
            title: required(input.title || `${criterion?.title || '验收项'}需要返工`, '标题'),
            contract: required(input.contract || criterion?.description, '验收标准'),
            reproductionSteps: Array.isArray(input.reproductionSteps) ? input.reproductionSteps.map(String).filter(Boolean).slice(0, 20) : (criterion?.steps || []).map(step => JSON.stringify(step)),
            actual: required(input.actual || result?.reason, '实际结果'),
            expected: required(input.expected || criterion?.description, '正确结果'),
            evidence: result ? { result: result.result, reason: result.reason, screenshotUrl: result.screenshotUrl || null, finalUrl: result.finalUrl || null } : null,
            severity: criterion?.severity || input.severity || 'blocker', status: 'open', createdAt: now, updatedAt: now,
            timeline: [{ status: 'open', at: now, note: '从验收证据创建' }]
          };
          data.issues.unshift(value); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'issue.created', entityType: 'issue', entityId: value.id, details: { runId: value.runId, criterionId: value.criterionId, severity: value.severity }, at: now }); return value;
        });
        return json(res, 201, issue);
      }
      if (req.method === 'GET' && url.pathname === '/api/issues') {
        const data = await store.read();
        const runId = url.searchParams.get('runId');
        const issues = data.issues.filter(item => item.workspaceId === workspaceId && (!runId || item.runId === runId || item.retestRunId === runId));
        return json(res, 200, issues);
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'issues' && segments[2] && segments[3] === 'handoff') {
        const issue = authData.issues.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!issue) return json(res, 404, { error: '返工单不存在' });
        const run = authData.runs.find(item => item.id === issue.runId && item.workspaceId === workspaceId);
        const project = run && authData.projects.find(item => item.id === run.projectId && item.workspaceId === workspaceId);
        if (!run || !project) return json(res, 409, { error: '返工单关联数据不完整' });
        return json(res, 200, buildHandoffPackage({ issue, run, project }));
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'issues' && segments[2] && segments[3] === 'export' && segments[4] === 'github') {
        requireRole(['owner', 'member']);
        const issue = authData.issues.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!issue) return json(res, 404, { error: '返工单不存在' });
        if (issue.externalRef) return json(res, 409, { error: '返工单已经导出到外部系统' });
        const run = authData.runs.find(item => item.id === issue.runId && item.workspaceId === workspaceId);
        const project = run && authData.projects.find(item => item.id === run.projectId && item.workspaceId === workspaceId);
        if (!run || !project) return json(res, 409, { error: '返工单关联数据不完整' });
        const handoff = buildHandoffPackage({ issue, run, project });
        const externalRef = await githubIssueCreator({ repo: project.githubRepo, token: process.env.GITHUB_TOKEN, title: `[ShipWitness] ${issue.title}`, body: handoff.prompt, labels: ['shipwitness', issue.severity || 'acceptance-failure'] });
        const saved = await store.update(data => {
          const current = data.issues.find(item => item.id === issue.id && item.workspaceId === workspaceId);
          current.externalRef = externalRef; current.updatedAt = new Date().toISOString();
          current.timeline ||= []; current.timeline.push({ status: current.status, at: current.updatedAt, note: `已导出到 ${externalRef.provider}: ${externalRef.url}` });
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'issue.exported', entityType: 'issue', entityId: current.id, details: { provider: externalRef.provider, externalId: externalRef.id, repo: externalRef.repo }, at: current.updatedAt });
          return current;
        });
        return json(res, 201, saved);
      }
      if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'issues' && segments[2] && segments.length === 3) {
        const input = await body(req);
        const allowed = ['open', 'handed_off', 'fixed', 'verified', 'closed'];
        const issue = await store.update(data => {
          const current = data.issues.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!current) throw Object.assign(new Error('返工单不存在'), { status: 404 });
          if (!allowed.includes(input.status)) throw Object.assign(new Error('返工单状态无效'), { status: 400 });
          if (current.status !== input.status) {
            current.status = input.status;
            current.updatedAt = new Date().toISOString();
            current.timeline ||= [];
            current.timeline.push({ status: input.status, at: current.updatedAt, note: String(input.note || '').slice(0, 500) });
            appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'issue.status_changed', entityType: 'issue', entityId: current.id, details: { from: current.timeline.at(-2)?.status || null, to: input.status, note: String(input.note || '').slice(0, 500) }, at: current.updatedAt });
          }
          return current;
        });
        return json(res, 200, issue);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'issues' && segments[2] && segments[3] === 'retest') {
        const retest = await store.update(data => {
          const issue = data.issues.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!issue) throw Object.assign(new Error('返工单不存在'), { status: 404 });
          const source = data.runs.find(item => item.id === issue.runId && item.workspaceId === workspaceId);
          if (!source) throw Object.assign(new Error('原验收记录不存在'), { status: 409 });
          const criteria = issue.criterionId ? source.criteria.filter(item => (item.contractId || item.code) === issue.criterionId) : source.criteria;
          if (!criteria.length) throw Object.assign(new Error('没有可复验的标准'), { status: 409 });
          const now = new Date().toISOString();
          const run = { id: createId('run'), workspaceId, projectId: source.projectId, requirement: `复验返工单 ${issue.id}：${issue.title}`, criteria, status: 'queued', parentRunId: source.id, issueIds: [issue.id], createdAt: now };
          data.runs.unshift(run);
          issue.status = 'retesting'; issue.retestRunId = run.id; issue.updatedAt = now;
          issue.timeline ||= []; issue.timeline.push({ status: 'retesting', at: now, note: `已创建复验任务 ${run.id}` });
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'issue.retest_created', entityType: 'issue', entityId: issue.id, details: { runId: run.id, sourceRunId: source.id }, at: now });
          return { issue, run };
        });
        return json(res, 201, retest);
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions') {
        requireRole(['owner', 'approver']);
        const input = await body(req);
        const decision = await store.update(data => {
          const runId = required(input.runId, '验收记录');
          const run = data.runs.find(item => item.id === runId && item.workspaceId === workspaceId);
          if (!run) throw Object.assign(new Error('验收记录不存在'), { status: 404 });
          if (run.status !== 'completed') throw Object.assign(new Error('任务尚未完成，不能签署发布决定'), { status: 409 });
          const verdict = required(input.verdict, '决定');
          if (!['approve', 'hold'].includes(verdict)) throw Object.assign(new Error('发布决定必须是 approve 或 hold'), { status: 400 });
          if (verdict === 'approve' && run.execution?.verdict !== 'passed') throw Object.assign(new Error('只有证据裁决通过的任务才能批准发布'), { status: 409 });
          const note = String(input.note || '').trim();
          if (verdict === 'hold' && !note) throw Object.assign(new Error('暂不发布必须填写原因'), { status: 400 });
          const value = { id: createId('decision'), workspaceId, runId, owner: currentUser.name, ownerUserId: currentUser.id, verdict, note, createdAt: new Date().toISOString() };
          data.decisions.unshift(value); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'release.decision_recorded', entityType: 'decision', entityId: value.id, details: { runId, verdict: value.verdict }, at: value.createdAt });
          for (const webhook of data.webhooks.filter(item => item.workspaceId === workspaceId && item.enabled && item.events.includes('release.decision'))) {
            const delivery = { id: createId('delivery'), workspaceId, webhookId: webhook.id, event: 'release.decision', payload: { schema: 'shipwitness.webhook.v1', event: 'release.decision', occurredAt: value.createdAt, data: { runId, decisionId: value.id, verdict, owner: value.owner } }, status: 'queued', attempts: 0, nextAttemptAt: value.createdAt, createdAt: value.createdAt };
            data.webhookDeliveries.push(delivery); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'webhook.queued', entityType: 'webhook_delivery', entityId: delivery.id, details: { webhookId: webhook.id, event: delivery.event }, at: value.createdAt });
          }
          return value;
        });
        return json(res, 201, decision);
      }
      if (req.method === 'GET' && url.pathname === '/api/decisions') {
        const runId = url.searchParams.get('runId');
        return json(res, 200, authData.decisions.filter(item => item.workspaceId === workspaceId && (!runId || item.runId === runId)));
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'gates' && segments[2]) {
        const run = authData.runs.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        const gate = evaluateReleaseGate({ run, decisions: authData.decisions.filter(item => item.workspaceId === workspaceId && item.runId === segments[2]), auditEvents: authData.auditEvents.filter(item => item.workspaceId === workspaceId) });
        if (apiKey) await store.update(data => { const key = data.apiKeys.find(item => item.id === apiKey.id); if (key) key.lastUsedAt = new Date().toISOString(); });
        return json(res, run ? 200 : 404, gate);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'dossiers' && segments[2] && segments[3] === 'sign') {
        requireRole(['owner', 'approver']);
        const signed = await store.update(data => {
          const run = data.runs.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!run) throw Object.assign(new Error('验收记录不存在'), { status: 404 });
          const gate = evaluateReleaseGate({ run, decisions: data.decisions.filter(item => item.workspaceId === workspaceId && item.runId === run.id), auditEvents: data.auditEvents.filter(item => item.workspaceId === workspaceId) });
          if (gate.status !== 'pass') throw Object.assign(new Error(`发布门禁未通过：${gate.reasons.join('；')}`), { status: 409 });
          const workspace = data.workspaces.find(item => item.id === workspaceId); workspace.signingKey ||= createSigningKey(signingSecret);
          const payload = { ...dossierPayload(data, run, workspaceId), gate, signedAt: new Date().toISOString() };
          const document = { id: createId('sd'), schema: 'shipwitness.signed-dossier.v1', workspaceId, runId: run.id, payload, signature: signPayload(payload, workspace.signingKey, signingSecret), createdByUserId: currentUser.id, createdAt: payload.signedAt };
          data.signedDossiers.unshift(document); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'dossier.signed', entityType: 'signed_dossier', entityId: document.id, details: { runId: run.id, algorithm: document.signature.algorithm }, at: document.createdAt }); return document;
        });
        return json(res, 201, signed);
      }
      if (req.method === 'GET' && url.pathname === '/api/signed-dossiers') {
        const runId = url.searchParams.get('runId');
        return json(res, 200, authData.signedDossiers.filter(item => item.workspaceId === workspaceId && (!runId || item.runId === runId)).map(item => ({ id: item.id, runId: item.runId, createdAt: item.createdAt, algorithm: item.signature.algorithm })));
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'signed-dossiers' && segments[2]) {
        const document = authData.signedDossiers.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        return document ? json(res, 200, { ...document, valid: verifySignedPayload(document.payload, document.signature) }) : json(res, 404, { error: '签名卷宗不存在' });
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'dossiers' && segments[2]) {
        const data = await store.read();
        const run = data.runs.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!run) return json(res, 404, { error: '验收记录不存在' });
        return json(res, 200, dossierPayload(data, run, workspaceId));
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'evidence' && segments[2] && segments[3] && segments.length === 4) {
        if (!authData.runs.some(item => item.id === segments[2] && item.workspaceId === workspaceId)) return json(res, 404, { error: '验收记录不存在' });
        const evidenceRoot = resolve(artifactsDir, segments[2]);
        const file = resolve(evidenceRoot, normalize(segments[3]));
        if (!file.startsWith(`${evidenceRoot}/`) || extname(file) !== '.png') return json(res, 403, { error: '禁止访问' });
        try {
          const content = await readFile(file);
          res.writeHead(200, { ...securityHeaders, 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(content);
        } catch { return json(res, 404, { error: '证据文件不存在' }); }
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 404, { error: '接口不存在' });
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = resolve(publicDir, normalize(requested));
      if (!file.startsWith(`${publicDir}/`) && file !== join(publicDir, 'index.html')) return json(res, 403, { error: '禁止访问' });
      try {
        const content = await readFile(file);
        res.writeHead(200, { ...securityHeaders, 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300' });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch { json(res, 404, { error: '文件不存在' }); }
    } catch (error) {
      json(res, error.status || 500, { error: error.status ? error.message : '服务器内部错误' });
    }
  });
  server.processWebhookDeliveries = processWebhookDeliveries;
  server.closeStore = async () => { clearInterval(webhookTimer); await store.close?.(); };
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  const server = createApp();
  server.listen(port, host, () => console.log(`ShipWitness ${serviceVersion} running at http://${host}:${port}`));
  const shutdown = signal => {
    console.log(`${signal} received, closing ShipWitness`);
    server.close(async error => { await server.closeStore?.(); process.exit(error ? 1 : 0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
