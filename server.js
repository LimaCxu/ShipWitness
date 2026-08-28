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
import { normalizeGitHubRepository, readGitHubRepository } from './lib/github-repository.js';
import { githubWebhookTarget, verifyGitHubWebhook } from './lib/github-webhook.js';
import { evaluateReleaseGate } from './lib/release-gate.js';
import { createSigningKey, decryptSecret, encryptSecret, keyFromSecret, signPayload, verifySignedPayload } from './lib/signing.js';
import { sendWebhook, validateWebhookUrl } from './lib/webhook.js';
import { createSmtpSender, smtpConfig } from './lib/email.js';
import { fetchTarget, targetOrigins, validateTargetUrl } from './lib/target-policy.js';
import { checkBrowserAvailability, executeBrowserRun, normalizeSteps } from './lib/browser-executor.js';
import { clearSessionCookie, createSessionToken, hashPassword, readSessionToken, sessionCookie, verifyPassword } from './lib/auth.js';
import { releaseSupportStatus, supportPolicy } from './lib/support.js';
import { consumeMfaCode, createRecoveryCodes, createTotpSecret, hashRecoveryCode, verifyTotp } from './lib/mfa.js';
import { BackupManager, currentSchemaVersion } from './lib/backup-manager.js';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'outputs/shipwitness-prototype');
const defaultStore = process.env.SHIPWITNESS_STORE_FILE || join(root, 'data/store.json');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const serviceVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
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

const rawBody = async (req, maxBytes = 1_000_000) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const body = async req => {
  const raw = await rawBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式无效'), { status: 400 }); }
};

const required = (value, field, maxLength = 5000) => {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${field}不能为空`), { status: 400 });
  if (value.trim().length > maxLength) throw Object.assign(new Error(`${field}长度不能超过 ${maxLength} 个字符`), { status: 400 });
  return value.trim();
};

const acceptanceSecretLifecycle = (item, now = Date.now()) => {
  if (!item.expiresAt) return { status: 'no_expiry', daysRemaining: null };
  const remainingMs = new Date(item.expiresAt).getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { status: 'expired', daysRemaining: 0 };
  const daysRemaining = Math.ceil(remainingMs / 86_400_000);
  return { status: daysRemaining <= 14 ? 'expiring' : 'active', daysRemaining };
};
const acceptanceSecretIsUsable = (item, now = Date.now()) => acceptanceSecretLifecycle(item, now).status !== 'expired';
const acceptanceSecretExpiry = (input, now = Date.now()) => {
  const days = Number(input.expiresInDays ?? 90); const allowed = new Set([30, 90, 180, 365]);
  if (!allowed.has(days)) throw Object.assign(new Error('凭据有效期必须是 30、90、180 或 365 天'), { status: 400 });
  return new Date(now + days * 86_400_000).toISOString();
};

const normalizedEmail = value => {
  const email = required(value, '邮箱', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('邮箱格式无效'), { status: 400 });
  return email;
};

const maskedEmail = value => { const [local, domain] = String(value).split('@'); return `${local.slice(0, 2)}${local.length > 2 ? '***' : '*'}@${domain}`; };
const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
const normalizedPublicUrl = value => {
  if (!value) return null;
  let url; try { url = new URL(value); } catch { throw new Error('SHIPWITNESS_PUBLIC_URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('SHIPWITNESS_PUBLIC_URL 必须是无凭据的 HTTP(S) 地址');
  return url.toString().replace(/\/$/, '');
};

const starterKits = [
  { id: 'website', name: '官网与落地页', description: '确认页面能打开、主体可见，并出现最关键的品牌或业务文字。', icon: 'WEB', contracts: 2 },
  { id: 'dashboard', name: '后台与工作台', description: '确认工作台入口可访问、主内容区域可见，并出现核心模块名称。', icon: 'B2B', contracts: 2 },
  { id: 'login', name: '登录与账号入口', description: '确认登录页身份明确、密码输入框可见，并出现正确的登录提示。', icon: 'AUTH', contracts: 2 }
];

const starterContracts = ({ kitId, startPath, expectedText }) => {
  const identity = { code: 'PAGE-01', title: '页面身份正确', description: `打开 ${startPath} 后，页面必须出现“${expectedText}”。`, category: '业务流程', severity: 'blocker', steps: [{ action: 'goto', path: startPath }, { action: 'expectText', selector: 'body', value: expectedText }] };
  if (kitId === 'login') return [identity, { code: 'AUTH-01', title: '密码入口可用', description: '登录页必须显示可操作的密码输入框。', category: '安全', severity: 'blocker', steps: [{ action: 'goto', path: startPath }, { action: 'expectVisible', selector: 'input[type="password"]' }] }];
  const selector = kitId === 'dashboard' ? 'main' : 'body';
  return [identity, { code: kitId === 'dashboard' ? 'DASH-01' : 'VIEW-01', title: kitId === 'dashboard' ? '工作台主体可见' : '页面主体可见', description: kitId === 'dashboard' ? '页面必须渲染可见的主工作区。' : '页面主体必须完成渲染并可见。', category: '可用性', severity: 'major', steps: [{ action: 'goto', path: startPath }, { action: 'expectVisible', selector }] }];
};

const normalizeContractPack = contracts => {
  if (!Array.isArray(contracts) || !contracts.length) throw Object.assign(new Error('标准包不能为空'), { status: 400 });
  if (contracts.length > 100) throw Object.assign(new Error('单次最多导入 100 条标准'), { status: 400 });
  const codes = new Set();
  return contracts.map((item, index) => {
    const code = required(item?.code, `第 ${index + 1} 条标准编号`, 100).toUpperCase();
    if (codes.has(code)) throw Object.assign(new Error(`标准包内编号重复：${code}`), { status: 400 });
    codes.add(code);
    const severity = item.severity || 'blocker';
    if (!['blocker', 'major', 'minor'].includes(severity)) throw Object.assign(new Error(`标准 ${code} 的级别无效`), { status: 400 });
    return { code, title: required(item.title, `标准 ${code} 名称`, 500), description: required(item.description, `标准 ${code} 描述`), category: required(item.category || '业务流程', `标准 ${code} 分类`, 100), severity, steps: normalizeSteps(item.steps), enabled: item.enabled !== false };
  });
};

const buildInbox = (data, workspaceId, userId, role, now = new Date()) => {
  const projects = new Map(data.projects.filter(item => item.workspaceId === workspaceId).map(item => [item.id, item]));
  const decisions = new Set(data.decisions.filter(item => item.workspaceId === workspaceId).map(item => item.runId));
  const items = [];
  for (const run of data.runs.filter(item => item.workspaceId === workspaceId)) {
    const project = projects.get(run.projectId); const projectName = project?.name || '未命名项目';
    if (run.status === 'queued') items.push({ key: `run:${run.id}:queued`, type: 'execution', priority: 'normal', title: '等待执行验收', detail: `${projectName} · ${run.criteria.length} 条标准`, createdAt: run.createdAt, action: { kind: 'run', id: run.id } });
    if (run.status === 'running' && now - new Date(run.startedAt || run.createdAt) > 15 * 60_000) items.push({ key: `run:${run.id}:stale`, type: 'recovery', priority: 'high', title: '验收任务需要接管', detail: `${projectName} · 执行超过 15 分钟`, createdAt: run.startedAt || run.createdAt, action: { kind: 'run', id: run.id } });
    if (run.status === 'failed' || run.execution?.verdict === 'failed') items.push({ key: `run:${run.id}:failed`, type: 'failure', priority: 'high', title: '处理失败验收证据', detail: `${projectName} · 查看截图并生成返工单`, createdAt: run.finishedAt || run.execution?.finishedAt || run.createdAt, action: { kind: 'run', id: run.id } });
    if (run.status === 'completed' && run.execution?.verdict === 'passed' && !decisions.has(run.id) && ['owner', 'approver'].includes(role)) items.push({ key: `run:${run.id}:approval`, type: 'approval', priority: 'high', title: '等待发布审批', detail: `${projectName} · 全部标准已有通过证据`, createdAt: run.execution.finishedAt || run.createdAt, action: { kind: 'run', id: run.id } });
  }
  for (const issue of data.issues.filter(item => item.workspaceId === workspaceId && item.status === 'fixed')) {
    items.push({ key: `issue:${issue.id}:fixed`, type: 'retest', priority: 'high', title: '修复完成，等待复验', detail: issue.title, createdAt: issue.updatedAt || issue.createdAt, action: { kind: 'run', id: issue.runId } });
  }
  if (role === 'owner') for (const delivery of data.webhookDeliveries.filter(item => item.workspaceId === workspaceId && item.status === 'failed')) {
    items.push({ key: `webhook:${delivery.id}:failed`, type: 'delivery', priority: 'normal', title: '发布通知投递失败', detail: delivery.lastError || 'Webhook 已用尽重试次数', createdAt: delivery.lastAttemptAt || delivery.createdAt, action: { kind: 'automation', id: delivery.id } });
  }
  if (role === 'owner') for (const delivery of data.emailDeliveries.filter(item => item.workspaceId === workspaceId && item.status === 'failed')) {
    items.push({ key: `email:${delivery.id}:failed`, type: 'delivery', priority: 'normal', title: '邮件通知投递失败', detail: delivery.lastError || '邮件已用尽重试次数', createdAt: delivery.lastAttemptAt || delivery.createdAt, action: { kind: 'automation', id: delivery.id } });
  }
  if (['owner', 'approver'].includes(role)) for (const feedback of data.pilotFeedback.filter(item => item.workspaceId === workspaceId && item.status === 'new')) {
    items.push({ key: `feedback:${feedback.id}:new`, type: 'feedback', priority: feedback.severity === 'blocker' ? 'high' : 'normal', title: '新的试点反馈等待分级', detail: `${projects.get(feedback.projectId)?.name || '未关联项目'} · ${feedback.title}`, createdAt: feedback.createdAt, action: { kind: 'feedback', id: feedback.id } });
  }
  const readKeys = new Set(data.inboxReads.filter(item => item.workspaceId === workspaceId && item.userId === userId).map(item => item.itemKey));
  return items.map(item => ({ ...item, unread: !readKeys.has(item.key) })).sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || String(b.createdAt).localeCompare(String(a.createdAt)));
};

const publicUser = user => ({ id: user.id, email: user.email, name: user.name, createdAt: user.createdAt, mustChangePassword: Boolean(user.mustChangePassword), mfaEnabled: Boolean(user.mfaSecretEncrypted) });
const githubDeliveryForWorkspace = (item, workspaceId, projects) => {
  const projectIds = new Set(projects.filter(project => project.workspaceId === workspaceId).map(project => project.id)); const { workspaceIds: hidden, ...safe } = item;
  return { ...safe, projectIds: (item.projectIds || []).filter(id => projectIds.has(id)), results: (item.results || []).filter(result => projectIds.has(result.projectId)) };
};
const sessionTokenHash = token => createHash('sha256').update(String(token || '')).digest('hex');
const sessionMetadata = req => ({
  ip: String(req.socket.remoteAddress || '').slice(0, 100) || null,
  userAgent: String(req.headers['user-agent'] || '').trim().slice(0, 500) || null
});
const publicSession = (item, currentTokenHash) => ({
  id: item.id,
  current: item.tokenHash === currentTokenHash,
  createdAt: item.createdAt,
  expiresAt: item.expiresAt,
  ip: item.ip || null,
  userAgent: item.userAgent || null
});
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

const alertSignals = (data, workspaceId, now = Date.now()) => {
  const runs = data.runs.filter(item => item.workspaceId === workspaceId);
  const deliveries = data.webhookDeliveries.filter(item => item.workspaceId === workspaceId);
  const signals = [];
  const audit = verifyAuditChain(data.auditEvents.filter(item => item.workspaceId === workspaceId));
  const staleRuns = runs.filter(item => item.status === 'running' && now - new Date(item.startedAt || 0).getTime() > 15 * 60_000);
  const failedRuns = runs.filter(item => item.status === 'failed');
  const failedDeliveries = deliveries.filter(item => item.status === 'failed');
  const secretStates = data.acceptanceSecrets.filter(item => item.workspaceId === workspaceId).map(item => ({ item, lifecycle: acceptanceSecretLifecycle(item, now) }));
  const expiredSecrets = secretStates.filter(value => value.lifecycle.status === 'expired'); const expiringSecrets = secretStates.filter(value => value.lifecycle.status === 'expiring');
  if (!audit.valid) signals.push({ sourceKey: 'audit.integrity', severity: 'critical', title: '审计链完整性异常', detail: `发现断点 ${audit.brokenEventId || 'unknown'}，暂停依赖该审计链的发布决策。`, count: 1 });
  if (staleRuns.length) signals.push({ sourceKey: 'runs.stale', severity: 'critical', title: '验收任务长时间未结束', detail: `${staleRuns.length} 个任务运行超过 15 分钟，需要检查执行器或重新接管。`, count: staleRuns.length });
  if (failedDeliveries.length) signals.push({ sourceKey: 'webhooks.failed', severity: 'critical', title: 'Webhook 投递最终失败', detail: `${failedDeliveries.length} 个发布通知已耗尽重试次数，需要检查目标地址。`, count: failedDeliveries.length });
  if (failedRuns.length) signals.push({ sourceKey: 'runs.failed', severity: 'warning', title: '存在失败的验收任务', detail: `${failedRuns.length} 个任务执行失败，请查看证据和返工记录。`, count: failedRuns.length });
  if (expiredSecrets.length) signals.push({ sourceKey: 'acceptance_secrets.expired', severity: 'critical', title: '验收凭据已经过期', detail: `${expiredSecrets.length} 个凭据已停止用于任务执行，请管理员立即轮换。`, count: expiredSecrets.length });
  if (expiringSecrets.length) signals.push({ sourceKey: 'acceptance_secrets.expiring', severity: 'warning', title: '验收凭据即将到期', detail: `${expiringSecrets.length} 个凭据将在 14 天内到期，请安排轮换。`, count: expiringSecrets.length });
  return signals;
};

const refreshAlerts = (data, workspaceId, actorUserId) => {
  const now = new Date().toISOString(); const signals = alertSignals(data, workspaceId);
  for (const signal of signals) {
    let alert = data.alerts.find(item => item.workspaceId === workspaceId && item.sourceKey === signal.sourceKey && item.status !== 'resolved');
    if (!alert) {
      alert = { id: createId('alt'), workspaceId, ...signal, status: 'open', createdAt: now, lastSeenAt: now };
      data.alerts.push(alert); appendAudit(data, { workspaceId, actorUserId, action: 'alert.opened', entityType: 'alert', entityId: alert.id, details: { sourceKey: alert.sourceKey, severity: alert.severity }, at: now });
    } else Object.assign(alert, signal, { lastSeenAt: now });
  }
  const activeKeys = new Set(signals.map(item => item.sourceKey));
  for (const alert of data.alerts.filter(item => item.workspaceId === workspaceId && item.status !== 'resolved' && !activeKeys.has(item.sourceKey))) {
    alert.status = 'resolved'; alert.resolvedAt = now; alert.resolvedByUserId = actorUserId; alert.resolution = '系统在刷新时确认异常条件已消失';
    appendAudit(data, { workspaceId, actorUserId, action: 'alert.resolved', entityType: 'alert', entityId: alert.id, details: { sourceKey: alert.sourceKey, automatic: true }, at: now });
  }
  return data.alerts.filter(item => item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

const retentionPreview = (data, workspaceId, asOf = new Date()) => {
  const workspace = data.workspaces.find(item => item.id === workspaceId);
  const operationalDays = workspace?.retention?.operationalDays || 90;
  const cutoff = new Date(asOf.getTime() - operationalDays * 86400_000);
  const sessions = data.sessions.filter(item => item.workspaceId === workspaceId && new Date(item.expiresAt) < cutoff);
  const webhookDeliveries = data.webhookDeliveries.filter(item => item.workspaceId === workspaceId && ['delivered', 'failed', 'cancelled'].includes(item.status) && new Date(item.deliveredAt || item.lastAttemptAt || item.createdAt) < cutoff);
  const emailDeliveries = data.emailDeliveries.filter(item => item.workspaceId === workspaceId && ['delivered', 'failed', 'cancelled'].includes(item.status) && new Date(item.deliveredAt || item.lastAttemptAt || item.createdAt) < cutoff);
  const githubDeliveries = data.githubDeliveries.filter(item => item.workspaceIds?.length === 1 && item.workspaceIds[0] === workspaceId && ['synced', 'failed', 'ignored'].includes(item.status) && new Date(item.updatedAt || item.receivedAt) < cutoff);
  const idempotencyRecords = data.idempotencyRecords.filter(item => item.workspaceId === workspaceId && new Date(item.createdAt) < cutoff);
  const alerts = data.alerts.filter(item => item.workspaceId === workspaceId && item.status === 'resolved' && new Date(item.resolvedAt || item.createdAt) < cutoff);
  const invitations = data.invitations.filter(item => item.workspaceId === workspaceId && (item.acceptedAt || item.revokedAt || new Date(item.expiresAt) <= asOf) && new Date(item.acceptedAt || item.revokedAt || item.expiresAt) < cutoff);
  const counts = { sessions: sessions.length, webhookDeliveries: webhookDeliveries.length, emailDeliveries: emailDeliveries.length, githubDeliveries: githubDeliveries.length, idempotencyRecords: idempotencyRecords.length, alerts: alerts.length, invitations: invitations.length };
  const ids = { sessions: sessions.map(item => item.id).sort(), webhookDeliveries: webhookDeliveries.map(item => item.id).sort(), emailDeliveries: emailDeliveries.map(item => item.id).sort(), githubDeliveries: githubDeliveries.map(item => item.id).sort(), idempotencyRecords: idempotencyRecords.map(item => item.id).sort(), alerts: alerts.map(item => item.id).sort(), invitations: invitations.map(item => item.id).sort() };
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const token = createHash('sha256').update(JSON.stringify({ workspaceId, asOf: asOf.toISOString(), cutoff: cutoff.toISOString(), counts, ids })).digest('hex');
  return { operationalDays, asOf: asOf.toISOString(), cutoff: cutoff.toISOString(), counts, total, token, ids };
};

const securityReviewSnapshot = (data, review, workspaceId, asOf = new Date()) => {
  const findings = data.securityFindings.filter(item => item.workspaceId === workspaceId && item.reviewId === review.id).sort((a, b) => a.id.localeCompare(b.id)).map(item => ({ id: item.id, severity: item.severity, title: item.title, description: item.description, remediation: item.remediation, status: item.status, retestEvidence: item.retestEvidence || null, verifiedAt: item.verifiedAt || null, riskAcceptance: item.riskAcceptance ? { rationale: item.riskAcceptance.rationale, acceptedAt: item.riskAcceptance.acceptedAt, expiresAt: item.riskAcceptance.expiresAt } : null, updatedAt: item.updatedAt }));
  const sourceUpdatedAt = [review.createdAt, ...findings.map(item => item.updatedAt)].sort().at(-1);
  const activeRiskAcceptance = item => item.status === 'risk_accepted' && new Date(item.riskAcceptance?.expiresAt) > asOf;
  return { review: { id: review.id, provider: review.provider, reference: review.reference, reviewedAt: review.reviewedAt, scope: review.scope, summary: review.summary }, findings, summary: { total: findings.length, critical: findings.filter(item => item.severity === 'critical').length, high: findings.filter(item => item.severity === 'high').length, medium: findings.filter(item => item.severity === 'medium').length, low: findings.filter(item => item.severity === 'low').length, verified: findings.filter(item => item.status === 'verified').length, riskAccepted: findings.filter(activeRiskAcceptance).length, expiredRiskAcceptances: findings.filter(item => item.status === 'risk_accepted' && !activeRiskAcceptance(item)).length, unresolved: findings.filter(item => item.status !== 'verified' && !activeRiskAcceptance(item)).length }, sourceUpdatedAt };
};

export function createApp({ storeFile = defaultStore, databaseUrl = process.env.DATABASE_URL, drillDatabaseUrl = process.env.SHIPWITNESS_DRILL_DATABASE_URL, store: providedStore, githubIssueCreator = createGitHubIssue, githubRepositoryReader = readGitHubRepository, githubWebhookSecret = process.env.SHIPWITNESS_GITHUB_WEBHOOK_SECRET, signingSecret = process.env.SHIPWITNESS_MASTER_KEY, webhookSender = sendWebhook, webhookUrlValidator = validateWebhookUrl, webhookRetryBaseMs = 60_000, emailConfiguration = smtpConfig(), emailSender, emailRetryBaseMs = 60_000, publicUrl = normalizedPublicUrl(process.env.SHIPWITNESS_PUBLIC_URL), allowedTargetOrigins = targetOrigins(), lastVerifiedBackupAt = process.env.SHIPWITNESS_LAST_VERIFIED_BACKUP_AT, securityReviewReference = process.env.SHIPWITNESS_SECURITY_REVIEW_REFERENCE, securityReviewedAt = process.env.SHIPWITNESS_SECURITY_REVIEWED_AT, version = serviceVersion, releasedAt = process.env.SHIPWITNESS_RELEASED_AT, endOfSupportAt = process.env.SHIPWITNESS_END_OF_SUPPORT_AT, browserRunExecutor = executeBrowserRun, basicRunExecutor = executeRun, backupRoot = process.env.SHIPWITNESS_BACKUP_DIR || join(dirname(storeFile), 'backups'), backupManager: providedBackupManager } = {}) {
  const store = providedStore || (databaseUrl ? new PostgresStore(databaseUrl) : new JsonStore(storeFile));
  const artifactsDir = process.env.SHIPWITNESS_ARTIFACTS_DIR || join(dirname(storeFile), 'evidence');
  const backupManager = providedBackupManager || new BackupManager({ databaseUrl, drillDatabaseUrl, artifactsDir, backupRoot, version, schemaVersion: currentSchemaVersion });
  let verifiedBackupAt = lastVerifiedBackupAt || null;
  const loginAttempts = new Map();
  const resolvedEmailSender = emailSender === undefined ? createSmtpSender(emailConfiguration) : emailSender;
  const emailEnabled = typeof resolvedEmailSender === 'function';
  if (emailEnabled && !signingSecret) throw new Error('启用邮件通知时必须配置 SHIPWITNESS_MASTER_KEY');
  const setupStatus = async () => {
    const data = await store.read(); const storage = await store.health(); let masterKeyConfigured = false;
    try { keyFromSecret(signingSecret); masterKeyConfigured = true; } catch {}
    const publicUrlConfigured = Boolean(publicUrl); const publicHttps = Boolean(publicUrl && new URL(publicUrl).protocol === 'https:');
    const checks = [
      { id: 'storage', label: '数据存储', status: storage.status === 'ready' ? 'pass' : 'block', detail: storage.engine || '存储不可用' },
      { id: 'master_key', label: '主密钥', status: masterKeyConfigured ? 'pass' : 'warning', detail: masterKeyConfigured ? '已配置持久化加密密钥' : '未配置持久化主密钥，不能启用签名与敏感集成' },
      { id: 'public_url', label: '公开地址', status: publicHttps ? 'pass' : publicUrlConfigured ? 'warning' : 'warning', detail: publicHttps ? '已配置 HTTPS 公开地址' : publicUrlConfigured ? '公开地址不是 HTTPS，仅适合本地或受控网络' : '未配置公开地址，邀请与找回链接需手动处理' },
      { id: 'email', label: '邮件服务', status: emailEnabled ? 'pass' : 'warning', detail: emailEnabled ? 'SMTP 已配置' : 'SMTP 未配置，通知不会主动发送' }
    ];
    return { needsSetup: !data.users.length, version, deploymentMode: publicHttps ? 'public_candidate' : 'controlled_pilot', storage: { status: storage.status, engine: storage.engine || 'unknown' }, masterKeyConfigured, publicUrlConfigured, publicHttps, emailEnabled, checks };
  };
  const deploymentConfiguration = async () => {
    const storage = await store.health(); let masterKeyConfigured = false;
    try { keyFromSecret(signingSecret); masterKeyConfigured = true; } catch {}
    const publicUrlConfigured = Boolean(publicUrl); const publicHttps = Boolean(publicUrl && new URL(publicUrl).protocol === 'https:');
    const postgresConfigured = Boolean(databaseUrl) && String(storage.engine || '').toLowerCase().startsWith('postgresql'); const smtpTlsRequired = Boolean(emailConfiguration?.enabled && emailConfiguration.requireTLS !== false);
    const items = [
      { id: 'database', label: 'PostgreSQL 数据库', status: postgresConfigured ? 'pass' : 'block', configured: postgresConfigured, detail: postgresConfigured ? '已通过 PostgreSQL 健康检查。' : '当前不是可交付的 PostgreSQL 存储。', requiredVariables: ['DATABASE_URL'], action: postgresConfigured ? null : '配置独立 PostgreSQL，并完成迁移与健康检查。' },
      { id: 'master_key', label: '持久化主密钥', status: masterKeyConfigured ? 'pass' : 'block', configured: masterKeyConfigured, detail: masterKeyConfigured ? '主密钥格式有效；具体值不会进入本清单。' : '签名、加密和密钥轮换没有持久化根密钥。', requiredVariables: ['SHIPWITNESS_MASTER_KEY'], action: masterKeyConfigured ? null : '生成 32 字节 Base64 密钥并存入部署侧秘密管理。' },
      { id: 'public_url', label: 'HTTPS 公开地址', status: publicHttps ? 'pass' : 'block', configured: publicUrlConfigured, detail: publicHttps ? '公开地址已配置为 HTTPS；域名不会进入导出。' : publicUrlConfigured ? '已配置地址，但不是 HTTPS。' : '尚未配置公开地址。', requiredVariables: ['SHIPWITNESS_PUBLIC_URL'], action: publicHttps ? null : '在反向代理启用 HTTPS，并填写平台公开地址。' },
      { id: 'email', label: 'SMTP 邮件通知', status: emailEnabled && smtpTlsRequired ? 'pass' : 'warning', configured: emailEnabled, detail: emailEnabled ? smtpTlsRequired ? '邮件服务已启用并要求 TLS。' : '邮件服务已启用，但未强制 TLS。' : '未启用邮件，邀请和找回密码不能主动送达。', requiredVariables: ['SHIPWITNESS_SMTP_HOST', 'SHIPWITNESS_SMTP_FROM', 'SHIPWITNESS_SMTP_REQUIRE_TLS'], action: emailEnabled && smtpTlsRequired ? null : '配置 SMTP，并保持 TLS 要求开启。' },
      { id: 'github', label: 'GitHub 签名事件', status: githubWebhookSecret ? 'pass' : 'warning', configured: Boolean(githubWebhookSecret), detail: githubWebhookSecret ? 'Webhook 签名密钥已配置。' : '未启用 GitHub 自动同步，可继续人工同步。', requiredVariables: ['SHIPWITNESS_GITHUB_WEBHOOK_SECRET'], action: githubWebhookSecret ? null : '如需自动同步 push 与 CI，再配置 Webhook 签名密钥。' },
      { id: 'backup', label: '备份目录与恢复点', status: backupManager.available && verifiedBackupAt ? 'pass' : 'warning', configured: Boolean(backupManager.available), detail: !backupManager.available ? '当前存储模式不支持数据库备份中心。' : verifiedBackupAt ? '备份中心可用，且存在已验证恢复点。' : '备份中心可用，但尚无已验证恢复点。', requiredVariables: ['SHIPWITNESS_BACKUP_DIR'], action: backupManager.available && verifiedBackupAt ? null : '使用 PostgreSQL 部署，创建备份并完成完整性校验。' },
      { id: 'target_policy', label: '验收目标白名单', status: allowedTargetOrigins.length ? 'pass' : 'warning', configured: Boolean(allowedTargetOrigins.length), detail: allowedTargetOrigins.length ? `已允许 ${allowedTargetOrigins.length} 个目标来源；地址不会进入导出。` : '尚未配置显式目标来源，执行器仅接受默认本机范围。', requiredVariables: ['SHIPWITNESS_ALLOWED_TARGET_ORIGINS'], action: allowedTargetOrigins.length ? null : '按最小范围配置允许验收的来源地址。' },
      { id: 'security_review', label: '独立安全评审证据', status: securityReviewReference && securityReviewedAt ? 'pass' : 'warning', configured: Boolean(securityReviewReference && securityReviewedAt), detail: securityReviewReference && securityReviewedAt ? '已登记外部评审元数据；报告内容不会进入清单。' : '尚未同时登记外部评审编号和完成日期。', requiredVariables: ['SHIPWITNESS_SECURITY_REVIEW_REFERENCE', 'SHIPWITNESS_SECURITY_REVIEWED_AT'], action: securityReviewReference && securityReviewedAt ? null : '正式公网发布前登记一年内独立安全评审。' }
    ];
    const blockers = items.filter(item => item.status === 'block').length; const warnings = items.filter(item => item.status === 'warning').length;
    return { schema: 'shipwitness.deployment-configuration.v1', generatedAt: new Date().toISOString(), version, deploymentMode: publicHttps ? 'public_candidate' : 'controlled_pilot', verdict: { level: blockers ? 'incomplete' : warnings ? 'attention' : 'ready', blockers, warnings, passed: items.filter(item => item.status === 'pass').length }, boundary: '本清单只包含配置状态和环境变量名称，不包含地址、账号、密码、密钥、目录或连接字符串。部署配置只能在运行环境中修改。', items };
  };
  const queueEmail = (data, { workspaceId, to, kind, subject, text, html, entityId }) => {
    if (!emailEnabled) return null;
    const now = new Date().toISOString(); const item = { id: createId('eml'), workspaceId, to, kind, encryptedMessage: encryptSecret(JSON.stringify({ to, subject, text, html }), signingSecret), entityId, status: 'queued', attempts: 0, nextAttemptAt: now, createdAt: now };
    data.emailDeliveries.unshift(item); appendAudit(data, { workspaceId, action: 'email.queued', entityType: 'email_delivery', entityId: item.id, details: { kind, recipient: maskedEmail(to) }, at: now }); return item;
  };
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
  const processEmailDeliveries = async () => {
    if (!emailEnabled) return 0;
    const snapshot = await store.read(); const now = new Date();
    const due = snapshot.emailDeliveries.filter(item => (['queued', 'retrying'].includes(item.status) && new Date(item.nextAttemptAt) <= now) || (item.status === 'sending' && new Date(item.lastAttemptAt || 0) <= new Date(now.getTime() - 5 * 60_000))).slice(0, 10);
    for (const candidate of due) {
      const claimed = await store.update(data => {
        const delivery = data.emailDeliveries.find(item => item.id === candidate.id); const stale = delivery?.status === 'sending' && new Date(delivery.lastAttemptAt || 0) <= new Date(Date.now() - 5 * 60_000);
        if (!delivery || (!['queued', 'retrying'].includes(delivery.status) && !stale) || (!stale && new Date(delivery.nextAttemptAt) > new Date())) return null;
        delivery.status = 'sending'; delivery.attempts += 1; delivery.lastAttemptAt = new Date().toISOString(); return { ...delivery };
      });
      if (!claimed) continue;
      try {
        const message = JSON.parse(decryptSecret(claimed.encryptedMessage, signingSecret)); const response = await resolvedEmailSender(message);
        await store.update(data => { const delivery = data.emailDeliveries.find(item => item.id === claimed.id); delivery.status = 'delivered'; delivery.deliveredAt = new Date().toISOString(); delivery.messageId = String(response?.messageId || '').slice(0, 300); appendAudit(data, { workspaceId: delivery.workspaceId, action: 'email.delivered', entityType: 'email_delivery', entityId: delivery.id, details: { kind: delivery.kind, attempts: delivery.attempts }, at: delivery.deliveredAt }); });
      } catch (error) {
        await store.update(data => { const delivery = data.emailDeliveries.find(item => item.id === claimed.id); delivery.lastError = String(error.message || '邮件投递失败').slice(0, 300); delivery.status = delivery.attempts >= 6 ? 'failed' : 'retrying'; delivery.nextAttemptAt = new Date(Date.now() + Math.min(emailRetryBaseMs * 2 ** (delivery.attempts - 1), 3_600_000)).toISOString(); if (delivery.status === 'failed') appendAudit(data, { workspaceId: delivery.workspaceId, action: 'email.failed', entityType: 'email_delivery', entityId: delivery.id, details: { kind: delivery.kind, attempts: delivery.attempts, error: delivery.lastError } }); });
      }
    }
    return due.length;
  };
  const emailTimer = setInterval(() => processEmailDeliveries().catch(() => undefined), 10_000); emailTimer.unref();
  const syncRepositoryProject = async ({ projectId, actorUserId = null, trigger = 'manual' }) => {
    const snapshot = await store.read(); const project = snapshot.projects.find(item => item.id === projectId && !item.archivedAt);
    if (!project) throw Object.assign(new Error('项目不存在或已归档'), { status: 404 });
    if (!project.githubRepo) throw Object.assign(new Error('请先配置 GitHub 仓库'), { status: 409 });
    const repositoryStatus = await githubRepositoryReader({ repository: project.githubRepo, branch: project.branch, token: process.env.GITHUB_TOKEN });
    return store.update(data => {
      const current = data.projects.find(item => item.id === project.id && !item.archivedAt);
      if (!current) throw Object.assign(new Error('项目不存在或已归档'), { status: 404 });
      if (current.githubRepo !== project.githubRepo || current.branch !== project.branch) throw Object.assign(new Error('仓库配置已变化，请重新同步'), { status: 409 });
      current.repositoryStatus = repositoryStatus; current.updatedAt = repositoryStatus.syncedAt;
      appendAudit(data, { workspaceId: current.workspaceId, actorUserId, action: 'project.repository_synced', entityType: 'project', entityId: current.id, details: { trigger, provider: repositoryStatus.provider, repository: repositoryStatus.repository, branch: repositoryStatus.branch, commitSha: repositoryStatus.commit.sha, checksState: repositoryStatus.checks.state }, at: repositoryStatus.syncedAt });
      return current.repositoryStatus;
    });
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const requestedPath = url.pathname;
      const versionedApi = requestedPath === '/api/v1' || requestedPath.startsWith('/api/v1/');
      if (versionedApi) {
        res.setHeader('x-shipwitness-api-version', 'v1');
        url.pathname = requestedPath.replace(/^\/api\/v1(?=\/|$)/, '/api');
      }
      const segments = url.pathname.split('/').filter(Boolean);
      const secureCookie = req.headers['x-forwarded-proto'] === 'https';

      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
        const expectedOrigin = `${secureCookie ? 'https' : 'http'}://${req.headers.host}`;
        if (req.headers.origin !== expectedOrigin) return json(res, 403, { error: '请求来源无效' });
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        try { return json(res, 200, { ok: true, service: 'shipwitness', version, uptimeSeconds: Math.round(process.uptime()), storage: await store.health() }); }
        catch { return json(res, 503, { ok: false, service: 'shipwitness', version, error: '存储当前不可用' }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/support') return json(res, 200, { ...supportPolicy, currentRelease: releaseSupportStatus({ version, releasedAt, endOfSupportAt }) });
      if (req.method === 'GET' && requestedPath === '/api/v1') return json(res, 200, {
        name: 'ShipWitness Extension API', version: 'v1', serviceVersion: version,
        authentication: 'Bearer API Key',
        scopes: ['acceptance:read', 'acceptance:write', 'gate:read', 'dossier:read'],
        resources: ['/api/v1/projects', '/api/v1/runs', '/api/v1/runs/:id', '/api/v1/runs/:id/execute', '/api/v1/runs/:id/retry', '/api/v1/dossiers/:runId', '/api/v1/gates/:runId']
      });
      if (req.method === 'GET' && url.pathname === '/api/setup/status') {
        return json(res, 200, await setupStatus());
      }
      if (req.method === 'POST' && url.pathname === '/api/password-reset/request') {
        const input = await body(req); const email = normalizedEmail(input.email); const generic = { accepted: true, message: '如果该邮箱存在且邮件服务可用，重置链接会在几分钟内发送。' };
        if (!emailEnabled || !publicUrl) return json(res, 202, generic);
        const snapshot = await store.read(); const user = snapshot.users.find(item => item.email === email); if (!user) return json(res, 202, generic);
        const membership = snapshot.memberships.find(item => item.userId === user.id); if (!membership) return json(res, 202, generic);
        const recent = snapshot.passwordResets.find(item => item.userId === user.id && !item.usedAt && !item.revokedAt && new Date(item.expiresAt) > new Date() && Date.now() - new Date(item.createdAt).getTime() < 60_000); if (recent) return json(res, 202, generic);
        const token = createSessionToken(); const now = new Date();
        await store.update(data => {
          for (const item of data.passwordResets.filter(item => item.userId === user.id && !item.usedAt && !item.revokedAt)) item.revokedAt = now.toISOString();
          const reset = { id: createId('pwr'), userId: user.id, tokenHash: sessionTokenHash(token), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), createdAt: now.toISOString(), requestedIp: String(req.socket.remoteAddress || '').slice(0, 100) || null };
          data.passwordResets.unshift(reset); const resetUrl = `${publicUrl}/?reset=${encodeURIComponent(token)}`;
          queueEmail(data, { workspaceId: membership.workspaceId, to: user.email, kind: 'password_reset', entityId: reset.id, subject: '重置你的 ShipWitness 密码', text: `请在 ${reset.expiresAt} 前打开以下一次性链接重置密码：${resetUrl}\n如果不是你发起的，请忽略本邮件。`, html: `<p>请在 ${htmlEscape(reset.expiresAt)} 前重置你的 ShipWitness 密码。</p><p><a href="${htmlEscape(resetUrl)}">重置密码</a></p><p>链接只能使用一次。如果不是你发起的，请忽略本邮件。</p>` });
          for (const joined of data.memberships.filter(item => item.userId === user.id)) appendAudit(data, { workspaceId: joined.workspaceId, actorUserId: user.id, action: 'user.password_reset_requested', entityType: 'password_reset', entityId: reset.id, details: { emailQueued: true }, at: reset.createdAt });
        });
        return json(res, 202, generic);
      }
      if (segments[0] === 'api' && segments[1] === 'password-reset' && segments[2] && segments.length === 3 && ['GET', 'POST'].includes(req.method)) {
        if (segments[2].length > 200) return json(res, 410, { error: '密码重置链接无效或已过期' });
        const tokenHash = sessionTokenHash(segments[2]); const snapshot = await store.read(); const reset = snapshot.passwordResets.find(item => item.tokenHash === tokenHash);
        if (!reset || reset.usedAt || reset.revokedAt || new Date(reset.expiresAt) <= new Date()) return json(res, 410, { error: '密码重置链接无效或已过期' });
        const user = snapshot.users.find(item => item.id === reset.userId); if (!user) return json(res, 410, { error: '密码重置链接无效或已过期' });
        if (req.method === 'GET') return json(res, 200, { maskedEmail: maskedEmail(user.email), expiresAt: reset.expiresAt, mfaEnabled: Boolean(user.mfaSecretEncrypted) });
        const input = await body(req); const passwordHash = await hashPassword(input.newPassword); const changed = await store.update(data => {
          const current = data.passwordResets.find(item => item.id === reset.id && item.tokenHash === tokenHash); if (!current || current.usedAt || current.revokedAt || new Date(current.expiresAt) <= new Date()) throw Object.assign(new Error('密码重置链接无效或已过期'), { status: 410 });
          const account = data.users.find(item => item.id === current.userId); const at = new Date().toISOString(); account.passwordHash = passwordHash; account.passwordChangedAt = at; account.mustChangePassword = false; current.usedAt = at;
          for (const item of data.passwordResets.filter(item => item.userId === account.id && item.id !== current.id && !item.usedAt && !item.revokedAt)) item.revokedAt = at;
          const before = data.sessions.length; data.sessions = data.sessions.filter(item => item.userId !== account.id); data.mfaChallenges = data.mfaChallenges.filter(item => item.userId !== account.id); const sessionsRevoked = before - data.sessions.length;
          for (const joined of data.memberships.filter(item => item.userId === account.id)) appendAudit(data, { workspaceId: joined.workspaceId, actorUserId: account.id, action: 'user.password_reset_completed', entityType: 'user', entityId: account.id, details: { sessionsRevoked, mfaPreserved: Boolean(account.mfaSecretEncrypted) }, at }); return { passwordChangedAt: at, sessionsRevoked, mfaPreserved: Boolean(account.mfaSecretEncrypted) };
        });
        return json(res, 200, changed, { 'set-cookie': clearSessionCookie(secureCookie) });
      }
      if (req.method === 'POST' && url.pathname === '/api/integrations/github/webhook') {
        const raw = await rawBody(req, 2_000_000); verifyGitHubWebhook({ raw, signature: req.headers['x-hub-signature-256'], secret: githubWebhookSecret });
        const deliveryId = String(req.headers['x-github-delivery'] || ''); const event = String(req.headers['x-github-event'] || '');
        if (!/^[A-Za-z0-9-]{1,100}$/.test(deliveryId) || !/^[a-z_]{1,50}$/.test(event)) return json(res, 400, { error: 'GitHub Webhook 事件标识无效' });
        let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'GitHub Webhook JSON 无效' }); }
        const target = githubWebhookTarget(event, payload); const snapshot = await store.read();
        const repositoryProjects = snapshot.projects.filter(item => !item.archivedAt && item.githubRepo?.toLowerCase() === target.repository.toLowerCase());
        const projects = target.supported && target.branch ? repositoryProjects.filter(item => item.branch === target.branch) : [];
        const now = new Date().toISOString(); const claimed = await store.update(data => {
          const duplicate = data.githubDeliveries.find(item => item.deliveryId === deliveryId); if (duplicate) return { duplicate };
          const item = { id: createId('ghd'), deliveryId, event, action: String(payload.action || '').slice(0, 100) || null, repository: target.repository || null, branch: target.branch, projectIds: projects.map(item => item.id), workspaceIds: [...new Set(repositoryProjects.map(item => item.workspaceId))], status: projects.length ? 'processing' : 'ignored', attempts: projects.length ? 1 : 0, receivedAt: now, updatedAt: now };
          data.githubDeliveries.unshift(item); return { item };
        });
        if (claimed.duplicate) return json(res, 200, { accepted: true, duplicate: true, status: claimed.duplicate.status });
        const item = claimed.item; if (!projects.length) return json(res, 202, { accepted: true, status: 'ignored', reason: target.supported ? '没有匹配的仓库与分支' : '事件类型不触发同步' });
        const results = [];
        for (const project of projects) {
          try { const status = await syncRepositoryProject({ projectId: project.id, trigger: `github_webhook:${event}` }); results.push({ projectId: project.id, status: 'synced', commitSha: status.commit.sha, checksState: status.checks.state }); }
          catch (error) { results.push({ projectId: project.id, status: 'failed', error: String(error.message || '同步失败').slice(0, 300) }); }
        }
        const final = await store.update(data => { const current = data.githubDeliveries.find(value => value.id === item.id); current.results = results; current.status = results.some(value => value.status === 'failed') ? 'failed' : 'synced'; current.updatedAt = new Date().toISOString(); for (const workspaceId of current.workspaceIds) appendAudit(data, { workspaceId, action: `github.delivery_${current.status}`, entityType: 'github_delivery', entityId: current.id, details: { deliveryId, event, repository: current.repository, branch: current.branch, projects: current.projectIds.length }, at: current.updatedAt }); return current; });
        return json(res, final.status === 'synced' ? 200 : 202, { accepted: true, deliveryId, status: final.status, synced: results.filter(value => value.status === 'synced').length, failed: results.filter(value => value.status === 'failed').length });
      }
      if (req.method === 'POST' && url.pathname === '/api/setup') {
        const input = await body(req);
        const passwordHash = await hashPassword(input.password); const deployment = await setupStatus();
        const created = await store.update(data => {
          if (data.users.length) throw Object.assign(new Error('系统已经完成初始化'), { status: 409 });
          const now = new Date().toISOString();
          const workspace = { id: createId('ws'), name: required(input.workspaceName || '默认工作区', '工作区名称'), createdAt: now, initialization: { completedAt: now, version, deploymentMode: deployment.deploymentMode, storageEngine: deployment.storage.engine, masterKeyConfigured: deployment.masterKeyConfigured, publicUrlConfigured: deployment.publicUrlConfigured, publicHttps: deployment.publicHttps, emailEnabled: deployment.emailEnabled } };
          const user = { id: createId('usr'), email: normalizedEmail(input.email), name: required(input.name || '管理员', '姓名'), passwordHash, createdAt: now };
          const membership = { id: createId('mem'), workspaceId: workspace.id, userId: user.id, role: 'owner', createdAt: now };
          const token = createSessionToken();
          const session = { id: createId('ses'), tokenHash: sessionTokenHash(token), userId: user.id, workspaceId: workspace.id, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), createdAt: now, ...sessionMetadata(req) };
          data.workspaces.push(workspace); data.users.push(user); data.memberships.push(membership); data.sessions.push(session);
          for (const collection of ['projects', 'contracts', 'runs', 'issues', 'decisions']) for (const item of data[collection]) item.workspaceId ||= workspace.id;
          appendAudit(data, { workspaceId: workspace.id, actorUserId: user.id, action: 'workspace.initialized', entityType: 'workspace', entityId: workspace.id, details: { migratedCollections: ['projects', 'contracts', 'runs', 'issues', 'decisions'], deploymentMode: deployment.deploymentMode, storageEngine: deployment.storage.engine, masterKeyConfigured: deployment.masterKeyConfigured, publicUrlConfigured: deployment.publicUrlConfigured, publicHttps: deployment.publicHttps, emailEnabled: deployment.emailEnabled }, at: now });
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
        const membership = data.memberships.find(item => item.userId === user.id && !item.disabledAt);
        if (!membership) return json(res, 403, { error: '账号尚未加入工作区' });
        if (user.mfaSecretEncrypted) {
          const challengeToken = createSessionToken(); const now = new Date();
          await store.update(current => {
            current.mfaChallenges = current.mfaChallenges.filter(item => item.userId !== user.id && new Date(item.expiresAt) > now);
            current.mfaChallenges.push({ id: createId('mfa'), tokenHash: sessionTokenHash(challengeToken), userId: user.id, workspaceId: membership.workspaceId, attempts: 0, expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), createdAt: now.toISOString(), ...sessionMetadata(req) });
          });
          return json(res, 202, { mfaRequired: true, challengeToken, expiresInSeconds: 300 });
        }
        const token = createSessionToken(); const now = new Date().toISOString();
        await store.update(current => { current.sessions = current.sessions.filter(item => new Date(item.expiresAt) > new Date()); current.sessions.push({ id: createId('ses'), tokenHash: sessionTokenHash(token), userId: user.id, workspaceId: membership.workspaceId, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), createdAt: now, ...sessionMetadata(req) }); appendAudit(current, { workspaceId: membership.workspaceId, actorUserId: user.id, action: 'user.login', entityType: 'user', entityId: user.id, at: now }); });
        const workspace = data.workspaces.find(item => item.id === membership.workspaceId);
        return json(res, 200, { user: publicUser(user), workspace, role: membership.role }, { 'set-cookie': sessionCookie(token, { secure: secureCookie }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/login/mfa') {
        const input = await body(req); const challengeHash = sessionTokenHash(required(input.challengeToken, '登录挑战', 200)); const code = required(input.code, '验证码', 100); const now = new Date();
        const completed = await store.update(data => {
          data.mfaChallenges = data.mfaChallenges.filter(item => new Date(item.expiresAt) > now);
          const challenge = data.mfaChallenges.find(item => item.tokenHash === challengeHash);
          if (!challenge || challenge.attempts >= 5) return { error: '两步验证已失效，请重新登录', status: 401 };
          const user = data.users.find(item => item.id === challenge.userId); let membership = data.memberships.find(item => item.userId === challenge.userId && item.workspaceId === challenge.workspaceId && !item.disabledAt); let invitation = null;
          if (challenge.purpose === 'invitation') { invitation = data.invitations.find(item => item.id === challenge.invitationId && item.workspaceId === challenge.workspaceId && !item.revokedAt && !item.acceptedAt && new Date(item.expiresAt) > now); if (!invitation || membership) { data.mfaChallenges = data.mfaChallenges.filter(item => item.id !== challenge.id); return { error: membership ? '账号已经加入该工作区' : '邀请链接无效或已过期', status: membership ? 409 : 410 }; } }
          if (!user?.mfaSecretEncrypted || (!membership && !invitation)) { data.mfaChallenges = data.mfaChallenges.filter(item => item.id !== challenge.id); return { error: '两步验证状态已变化，请重新登录', status: 409 }; }
          const verification = consumeMfaCode(user, code, decryptSecret(user.mfaSecretEncrypted, signingSecret), now.getTime());
          if (!verification.valid) { challenge.attempts += 1; return { error: challenge.attempts >= 5 ? '验证码错误次数过多，请重新登录' : '验证码或恢复码错误', status: 401 }; }
          if (verification.method === 'recovery') user.mfaRecoveryCodeHashes.splice(verification.recoveryIndex, 1);
          data.mfaChallenges = data.mfaChallenges.filter(item => item.id !== challenge.id);
          if (invitation) { membership = { id: createId('mem'), workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role, createdAt: now.toISOString() }; invitation.acceptedAt = now.toISOString(); invitation.acceptedByUserId = user.id; data.memberships.push(membership); appendAudit(data, { workspaceId: invitation.workspaceId, actorUserId: user.id, action: 'invitation.accepted', entityType: 'invitation', entityId: invitation.id, details: { role: invitation.role, existingAccount: true, mfa: verification.method }, at: now.toISOString() }); }
          const token = createSessionToken(); const at = now.toISOString(); const session = { id: createId('ses'), tokenHash: sessionTokenHash(token), userId: user.id, workspaceId: membership.workspaceId, expiresAt: new Date(now.getTime() + 7 * 86400_000).toISOString(), createdAt: at, ip: challenge.ip, userAgent: challenge.userAgent };
          data.sessions.push(session); appendAudit(data, { workspaceId: membership.workspaceId, actorUserId: user.id, action: 'user.login', entityType: 'user', entityId: user.id, details: { mfa: verification.method }, at });
          return { user, membership, workspace: data.workspaces.find(item => item.id === membership.workspaceId), token, recoveryCodesRemaining: user.mfaRecoveryCodeHashes.length };
        });
        if (completed.error) return json(res, completed.status, { error: completed.error });
        return json(res, 200, { user: publicUser(completed.user), workspace: completed.workspace, role: completed.membership.role, recoveryCodesRemaining: completed.recoveryCodesRemaining }, { 'set-cookie': sessionCookie(completed.token, { secure: secureCookie }) });
      }
      if (segments[0] === 'api' && segments[1] === 'invitations' && segments[2] && segments.length === 3 && ['GET', 'POST'].includes(req.method)) {
        if (segments[2].length > 200) return json(res, 410, { error: '邀请链接无效或已过期' });
        const tokenHash = sessionTokenHash(segments[2]); const snapshot = await store.read();
        const invitation = snapshot.invitations.find(item => item.tokenHash === tokenHash);
        if (!invitation || invitation.revokedAt || invitation.acceptedAt || new Date(invitation.expiresAt) <= new Date()) return json(res, 410, { error: '邀请链接无效或已过期' });
        const workspace = snapshot.workspaces.find(item => item.id === invitation.workspaceId);
        const existingUser = snapshot.users.find(item => item.email === invitation.email);
        if (req.method === 'GET') return json(res, 200, { workspace: { name: workspace.name }, maskedEmail: maskedEmail(invitation.email), role: invitation.role, expiresAt: invitation.expiresAt, existingAccount: Boolean(existingUser) });
        const input = await body(req); let passwordHash = null;
        if (existingUser) {
          if (!await verifyPassword(input.password, existingUser.passwordHash)) return json(res, 401, { error: '账号密码错误' });
          if (existingUser.mfaSecretEncrypted) {
            const challengeToken = createSessionToken(); const challengeNow = new Date();
            await store.update(data => { data.mfaChallenges = data.mfaChallenges.filter(item => item.userId !== existingUser.id && new Date(item.expiresAt) > challengeNow); data.mfaChallenges.push({ id: createId('mfa'), tokenHash: sessionTokenHash(challengeToken), userId: existingUser.id, workspaceId: invitation.workspaceId, invitationId: invitation.id, purpose: 'invitation', attempts: 0, expiresAt: new Date(challengeNow.getTime() + 5 * 60_000).toISOString(), createdAt: challengeNow.toISOString(), ...sessionMetadata(req) }); });
            return json(res, 202, { mfaRequired: true, challengeToken, expiresInSeconds: 300 });
          }
        } else passwordHash = await hashPassword(input.password);
        const token = createSessionToken(); const now = new Date().toISOString();
        const accepted = await store.update(data => {
          const current = data.invitations.find(item => item.id === invitation.id && item.tokenHash === tokenHash);
          if (!current || current.revokedAt || current.acceptedAt || new Date(current.expiresAt) <= new Date()) throw Object.assign(new Error('邀请链接无效或已过期'), { status: 410 });
          let user = data.users.find(item => item.email === current.email);
          if (!user) { user = { id: createId('usr'), email: current.email, name: required(input.name, '姓名'), passwordHash, createdAt: now }; data.users.push(user); }
          else if (!existingUser || user.id !== existingUser.id) throw Object.assign(new Error('账号状态已变化，请重新打开邀请'), { status: 409 });
          if (data.memberships.some(item => item.workspaceId === current.workspaceId && item.userId === user.id)) throw Object.assign(new Error('账号已经加入该工作区'), { status: 409 });
          const membership = { id: createId('mem'), workspaceId: current.workspaceId, userId: user.id, role: current.role, createdAt: now };
          const session = { id: createId('ses'), tokenHash: sessionTokenHash(token), userId: user.id, workspaceId: current.workspaceId, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), createdAt: now, ...sessionMetadata(req) };
          current.acceptedAt = now; current.acceptedByUserId = user.id; data.memberships.push(membership); data.sessions.push(session);
          appendAudit(data, { workspaceId: current.workspaceId, actorUserId: user.id, action: 'invitation.accepted', entityType: 'invitation', entityId: current.id, details: { role: current.role, existingAccount: Boolean(existingUser) }, at: now });
          return { user, membership, workspace: data.workspaces.find(item => item.id === current.workspaceId) };
        });
        return json(res, 200, { user: publicUser(accepted.user), workspace: accepted.workspace, role: accepted.membership.role }, { 'set-cookie': sessionCookie(token, { secure: secureCookie }) });
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
      if ((session || apiKey) && (!membership || membership.disabledAt)) return json(res, 403, { error: '当前工作区访问已停用' }, session ? { 'set-cookie': clearSessionCookie(secureCookie) } : {});
      if (apiKey) {
        const acceptanceRead = versionedApi && req.method === 'GET' && ['/api/projects', '/api/runs', '/api/issues'].some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) && apiKey.scopes.includes('acceptance:read');
        const acceptanceWrite = versionedApi && req.method === 'POST' && (url.pathname === '/api/runs' || /^\/api\/runs\/[^/]+\/(execute|retry)$/.test(url.pathname)) && apiKey.scopes.includes('acceptance:write');
        const allowed = acceptanceRead || acceptanceWrite || (req.method === 'GET' && ((url.pathname.startsWith('/api/gates/') && apiKey.scopes.includes('gate:read')) || (url.pathname.startsWith('/api/dossiers/') && apiKey.scopes.includes('dossier:read')) || (url.pathname.startsWith('/api/signed-dossiers/') && apiKey.scopes.includes('dossier:read')) || (url.pathname.startsWith('/api/security-review-dossiers/') && apiKey.scopes.includes('dossier:read'))));
        if (!allowed) return json(res, 403, { error: 'API Key 作用域不足' });
        await store.update(data => { const key = data.apiKeys.find(item => item.id === apiKey.id); if (key) key.lastUsedAt = new Date().toISOString(); });
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        if (!session) return json(res, 403, { error: 'API Key 不能读取交互会话' });
        return json(res, 200, { user: publicUser(currentUser), workspace: currentWorkspace, role: membership?.role });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        await store.update(data => { data.sessions = data.sessions.filter(item => item.tokenHash !== cookieTokenHash); appendAudit(data, { workspaceId: session.workspaceId, actorUserId: currentUser.id, action: 'user.logout', entityType: 'user', entityId: currentUser.id }); });
        return json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(secureCookie) });
      }
      if (req.method === 'POST' && url.pathname === '/api/account/password') {
        if (!session) return json(res, 403, { error: 'API Key 不能修改用户密码' });
        const input = await body(req);
        if (!await verifyPassword(input.currentPassword, currentUser.passwordHash)) return json(res, 400, { error: '当前密码错误' });
        if (input.currentPassword === input.newPassword) return json(res, 400, { error: '新密码不能与当前密码相同' });
        const passwordHash = await hashPassword(input.newPassword); const now = new Date().toISOString();
        await store.update(data => {
          const user = data.users.find(item => item.id === currentUser.id); user.passwordHash = passwordHash; user.passwordChangedAt = now; user.mustChangePassword = false;
          data.sessions = data.sessions.filter(item => item.userId !== currentUser.id || item.tokenHash === cookieTokenHash);
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'user.password_changed', entityType: 'user', entityId: currentUser.id, at: now });
        });
        return json(res, 200, { ok: true, passwordChangedAt: now, otherSessionsRevoked: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/account/sessions') {
        if (!session) return json(res, 403, { error: 'API Key 不能读取用户会话' });
        const sessions = authData.sessions.filter(item => item.userId === currentUser.id && new Date(item.expiresAt) > new Date()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return json(res, 200, sessions.map(item => publicSession(item, cookieTokenHash)));
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'account' && segments[2] === 'sessions' && segments[3] && segments[4] === 'revoke') {
        if (!session) return json(res, 403, { error: 'API Key 不能撤销用户会话' });
        if (segments[3] === session.id) return json(res, 409, { error: '当前会话请使用退出登录结束' });
        const revoked = await store.update(data => {
          const target = data.sessions.find(item => item.id === segments[3] && item.userId === currentUser.id);
          if (!target) throw Object.assign(new Error('登录会话不存在或已失效'), { status: 404 });
          data.sessions = data.sessions.filter(item => item.id !== target.id);
          const at = new Date().toISOString();
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'user.session_revoked', entityType: 'session', entityId: target.id, details: { createdAt: target.createdAt, ip: target.ip || null }, at });
          return { id: target.id, revokedAt: at };
        });
        return json(res, 200, revoked);
      }
      if (req.method === 'GET' && url.pathname === '/api/account/mfa') {
        if (!session) return json(res, 403, { error: 'API Key 不能读取两步验证设置' });
        return json(res, 200, { enabled: Boolean(currentUser.mfaSecretEncrypted), enabledAt: currentUser.mfaEnabledAt || null, recoveryCodesRemaining: currentUser.mfaRecoveryCodeHashes?.length || 0 });
      }
      if (req.method === 'POST' && url.pathname === '/api/account/mfa/setup') {
        if (!session) return json(res, 403, { error: 'API Key 不能设置两步验证' });
        const input = await body(req); if (!await verifyPassword(input.currentPassword, currentUser.passwordHash)) return json(res, 400, { error: '当前密码错误' });
        if (currentUser.mfaSecretEncrypted) return json(res, 409, { error: '两步验证已经启用' });
        keyFromSecret(signingSecret); const secret = createTotpSecret(); const now = new Date().toISOString();
        await store.update(data => { const user = data.users.find(item => item.id === currentUser.id); user.mfaPendingSecretEncrypted = encryptSecret(secret, signingSecret); user.mfaPendingCreatedAt = now; });
        const issuer = 'ShipWitness'; const label = `${issuer}:${currentUser.email}`;
        return json(res, 200, { secret, otpauthUri: `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`, expiresInSeconds: 600 });
      }
      if (req.method === 'POST' && url.pathname === '/api/account/mfa/enable') {
        if (!session) return json(res, 403, { error: 'API Key 不能启用两步验证' });
        const input = await body(req); const enabled = await store.update(data => {
          const user = data.users.find(item => item.id === currentUser.id); const createdAt = new Date(user.mfaPendingCreatedAt || 0);
          if (!user.mfaPendingSecretEncrypted || !Number.isFinite(createdAt.getTime()) || Date.now() - createdAt.getTime() > 10 * 60_000) { delete user.mfaPendingSecretEncrypted; delete user.mfaPendingCreatedAt; return { error: '绑定请求已过期，请重新开始', status: 410 }; }
          const secret = decryptSecret(user.mfaPendingSecretEncrypted, signingSecret); if (!verifyTotp(input.code, secret)) return { error: '动态验证码错误', status: 400 };
          const recoveryCodes = createRecoveryCodes(); const at = new Date().toISOString(); user.mfaSecretEncrypted = user.mfaPendingSecretEncrypted; user.mfaRecoveryCodeHashes = recoveryCodes.map(hashRecoveryCode); user.mfaEnabledAt = at; delete user.mfaPendingSecretEncrypted; delete user.mfaPendingCreatedAt;
          const before = data.sessions.length; data.sessions = data.sessions.filter(item => item.userId !== user.id || item.tokenHash === cookieTokenHash); const sessionsRevoked = before - data.sessions.length;
          appendAudit(data, { workspaceId, actorUserId: user.id, action: 'user.mfa_enabled', entityType: 'user', entityId: user.id, details: { recoveryCodes: recoveryCodes.length, sessionsRevoked }, at }); return { recoveryCodes, enabledAt: at, sessionsRevoked };
        });
        if (enabled.error) return json(res, enabled.status, { error: enabled.error });
        return json(res, 200, enabled);
      }
      if (req.method === 'POST' && url.pathname === '/api/account/mfa/disable') {
        if (!session) return json(res, 403, { error: 'API Key 不能停用两步验证' });
        const input = await body(req); if (!await verifyPassword(input.currentPassword, currentUser.passwordHash)) return json(res, 400, { error: '当前密码错误' });
        const disabled = await store.update(data => {
          const user = data.users.find(item => item.id === currentUser.id); if (!user.mfaSecretEncrypted) return { error: '两步验证尚未启用', status: 409 };
          const verification = consumeMfaCode(user, input.code, decryptSecret(user.mfaSecretEncrypted, signingSecret)); if (!verification.valid) return { error: '验证码或恢复码错误', status: 400 };
          delete user.mfaSecretEncrypted; delete user.mfaRecoveryCodeHashes; delete user.mfaEnabledAt; delete user.mfaPendingSecretEncrypted; delete user.mfaPendingCreatedAt;
          const at = new Date().toISOString(); const before = data.sessions.length; data.sessions = data.sessions.filter(item => item.userId !== user.id || item.tokenHash === cookieTokenHash); const sessionsRevoked = before - data.sessions.length;
          appendAudit(data, { workspaceId, actorUserId: user.id, action: 'user.mfa_disabled', entityType: 'user', entityId: user.id, details: { verification: verification.method, sessionsRevoked }, at }); return { disabledAt: at, sessionsRevoked };
        });
        if (disabled.error) return json(res, disabled.status, { error: disabled.error });
        return json(res, 200, disabled);
      }

      if (currentUser?.mustChangePassword && !['GET', 'HEAD'].includes(req.method) && url.pathname !== '/api/alerts/refresh') return json(res, 428, { error: '管理员已重置密码，请先修改临时密码' });

      const requireRole = roles => {
        if (!membership || !roles.includes(membership.role)) throw Object.assign(new Error('当前角色无权执行此操作'), { status: 403 });
      };
      if (req.method === 'PATCH' && url.pathname === '/api/account/profile') {
        if (!session) return json(res, 403, { error: 'API Key 不能修改用户资料' });
        const input = await body(req); const name = required(input.name, '姓名', 100); const now = new Date().toISOString();
        const user = await store.update(data => {
          const current = data.users.find(item => item.id === currentUser.id);
          if (current.name === name) return current;
          const previousName = current.name; current.name = name; current.updatedAt = now;
          for (const joined of data.memberships.filter(item => item.userId === current.id)) appendAudit(data, { workspaceId: joined.workspaceId, actorUserId: current.id, action: 'user.profile_updated', entityType: 'user', entityId: current.id, details: { previousName, name }, at: now });
          return current;
        });
        return json(res, 200, publicUser(user));
      }
      if (req.method === 'GET' && url.pathname === '/api/inbox') {
        const items = buildInbox(authData, workspaceId, currentUser.id, membership.role);
        return json(res, 200, { items, unreadCount: items.filter(item => item.unread).length, total: items.length });
      }
      if (req.method === 'POST' && url.pathname === '/api/inbox/read') {
        const input = await body(req); const currentItems = buildInbox(authData, workspaceId, currentUser.id, membership.role); const validKeys = new Set(currentItems.map(item => item.key));
        const requested = input.all === true ? [...validKeys] : Array.isArray(input.keys) ? input.keys.slice(0, 200).filter(key => typeof key === 'string' && validKeys.has(key)) : [];
        await store.update(data => {
          const existing = new Set(data.inboxReads.filter(item => item.workspaceId === workspaceId && item.userId === currentUser.id).map(item => item.itemKey)); const now = new Date().toISOString();
          for (const itemKey of requested) if (!existing.has(itemKey)) data.inboxReads.push({ id: createId('ibr'), workspaceId, userId: currentUser.id, itemKey, readAt: now });
        });
        const refreshed = buildInbox(await store.read(), workspaceId, currentUser.id, membership.role);
        return json(res, 200, { read: requested.length, unreadCount: refreshed.filter(item => item.unread).length });
      }
      if (req.method === 'GET' && url.pathname === '/api/workspaces') {
        const ids = authData.memberships.filter(item => item.userId === currentUser.id && !item.disabledAt).map(item => item.workspaceId);
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
      if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'workspaces' && segments[2] && segments.length === 3) {
        requireRole(['owner']);
        if (segments[2] !== workspaceId) return json(res, 404, { error: '工作区不存在' });
        const input = await body(req); const name = required(input.name, '工作区名称', 120); const now = new Date().toISOString();
        const workspace = await store.update(data => {
          const current = data.workspaces.find(item => item.id === workspaceId);
          if (!current) throw Object.assign(new Error('工作区不存在'), { status: 404 });
          if (current.name === name) return current;
          const previousName = current.name; current.name = name; current.updatedAt = now;
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'workspace.renamed', entityType: 'workspace', entityId: current.id, details: { previousName, name }, at: now });
          return current;
        });
        return json(res, 200, workspace);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'workspaces' && segments[2] && segments[3] === 'select') {
        const targetMembership = authData.memberships.find(item => item.userId === currentUser.id && item.workspaceId === segments[2] && !item.disabledAt);
        if (!targetMembership) return json(res, 404, { error: '工作区不存在' });
        await store.update(data => { data.sessions.find(item => item.tokenHash === cookieTokenHash).workspaceId = targetMembership.workspaceId; appendAudit(data, { workspaceId: targetMembership.workspaceId, actorUserId: currentUser.id, action: 'workspace.selected', entityType: 'workspace', entityId: targetMembership.workspaceId }); });
        return json(res, 200, { workspace: authData.workspaces.find(item => item.id === targetMembership.workspaceId), role: targetMembership.role });
      }
      if (req.method === 'GET' && url.pathname === '/api/members') {
        const members = authData.memberships.filter(item => item.workspaceId === workspaceId).map(item => ({ ...publicUser(authData.users.find(user => user.id === item.userId)), role: item.role, membershipId: item.id }));
        for (const member of members) { const source = authData.memberships.find(item => item.id === member.membershipId); member.disabledAt = source.disabledAt || null; member.activeSessions = authData.sessions.filter(item => item.userId === member.id && item.workspaceId === workspaceId && new Date(item.expiresAt) > new Date()).length; }
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
      if (req.method === 'GET' && url.pathname === '/api/invitations') {
        requireRole(['owner']); const now = new Date();
        return json(res, 200, authData.invitations.filter(item => item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ tokenHash: hidden, ...item }) => ({ ...item, status: item.acceptedAt ? 'accepted' : item.revokedAt ? 'revoked' : new Date(item.expiresAt) <= now ? 'expired' : 'pending' })));
      }
      if (req.method === 'POST' && url.pathname === '/api/invitations') {
        requireRole(['owner']);
        const input = await body(req); const email = normalizedEmail(input.email); const role = input.role || 'member'; const expiresInHours = Number(input.expiresInHours ?? 72);
        if (!['owner', 'approver', 'member'].includes(role)) return json(res, 400, { error: '成员角色无效' });
        if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) return json(res, 400, { error: '邀请有效期必须是 1 到 168 小时' });
        const token = `swi_${randomBytes(32).toString('base64url')}`; const now = new Date();
        const created = await store.update(data => {
          const user = data.users.find(item => item.email === email);
          if (user && data.memberships.some(item => item.workspaceId === workspaceId && item.userId === user.id)) throw Object.assign(new Error('该用户已经是工作区成员'), { status: 409 });
          for (const item of data.invitations.filter(item => item.workspaceId === workspaceId && item.email === email && !item.acceptedAt && !item.revokedAt && new Date(item.expiresAt) > now)) { item.revokedAt = now.toISOString(); item.revokedByUserId = currentUser.id; item.revokeReason = 'replaced'; }
          const invitation = { id: createId('inv'), workspaceId, email, suggestedName: String(input.name || '').trim().slice(0, 200), role, tokenHash: sessionTokenHash(token), tokenSuffix: token.slice(-6), expiresAt: new Date(now.getTime() + expiresInHours * 3600_000).toISOString(), createdByUserId: currentUser.id, createdAt: now.toISOString() };
          data.invitations.unshift(invitation); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'invitation.created', entityType: 'invitation', entityId: invitation.id, details: { email, role, expiresAt: invitation.expiresAt }, at: invitation.createdAt });
          if (publicUrl) { const inviteUrl = `${publicUrl}/?invite=${encodeURIComponent(token)}`; queueEmail(data, { workspaceId, to: email, kind: 'workspace_invitation', entityId: invitation.id, subject: `加入 ${currentWorkspace.name} 的 ShipWitness 工作区`, text: `你被邀请加入 ${currentWorkspace.name}。请在 ${invitation.expiresAt} 前打开：${inviteUrl}`, html: `<p>你被邀请加入 <strong>${htmlEscape(currentWorkspace.name)}</strong>。</p><p><a href="${htmlEscape(inviteUrl)}">接受邀请并设置密码</a></p><p>链接将在 ${htmlEscape(invitation.expiresAt)} 过期，且只能使用一次。</p>` }); }
          return invitation;
        });
        const { tokenHash: hidden, ...safe } = created; return json(res, 201, { ...safe, token, invitePath: `/?invite=${encodeURIComponent(token)}`, emailQueued: emailEnabled && Boolean(publicUrl) });
      }
      if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'invitations' && segments[2]) {
        requireRole(['owner']);
        const revoked = await store.update(data => {
          const invitation = data.invitations.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!invitation) throw Object.assign(new Error('邀请不存在'), { status: 404 });
          if (invitation.acceptedAt) throw Object.assign(new Error('已接受的邀请不能撤销'), { status: 409 });
          if (!invitation.revokedAt) { invitation.revokedAt = new Date().toISOString(); invitation.revokedByUserId = currentUser.id; invitation.revokeReason = 'owner'; appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'invitation.revoked', entityType: 'invitation', entityId: invitation.id, details: { email: invitation.email }, at: invitation.revokedAt }); }
          return invitation;
        });
        return json(res, 200, { id: revoked.id, revokedAt: revoked.revokedAt });
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'members' && segments[2] && segments[3] === 'password') {
        requireRole(['owner']);
        const input = await body(req); const passwordHash = await hashPassword(input.newPassword); const now = new Date().toISOString();
        const result = await store.update(data => {
          const target = data.memberships.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!target) throw Object.assign(new Error('成员不存在'), { status: 404 });
          if (target.userId === currentUser.id) throw Object.assign(new Error('请通过账户安全修改自己的密码'), { status: 400 });
          const user = data.users.find(item => item.id === target.userId); user.passwordHash = passwordHash; user.passwordChangedAt = now; user.mustChangePassword = true;
          const sessionsBefore = data.sessions.length; data.sessions = data.sessions.filter(item => item.userId !== target.userId);
          const sessionsRevoked = sessionsBefore - data.sessions.length;
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'member.password_reset', entityType: 'user', entityId: target.userId, details: { membershipId: target.id, sessionsRevoked }, at: now });
          return { membershipId: target.id, userId: target.userId, passwordResetAt: now, sessionsRevoked, mustChangePassword: true };
        });
        return json(res, 200, result);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'members' && segments[2] && ['disable', 'enable'].includes(segments[3])) {
        requireRole(['owner']); const enable = segments[3] === 'enable'; const now = new Date().toISOString();
        const changed = await store.update(data => {
          const target = data.memberships.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!target) throw Object.assign(new Error('成员不存在'), { status: 404 });
          if (target.userId === currentUser.id) throw Object.assign(new Error('不能停用或启用自己的工作区访问'), { status: 400 });
          if (!enable && target.role === 'owner' && data.memberships.filter(item => item.workspaceId === workspaceId && item.role === 'owner' && !item.disabledAt && item.id !== target.id).length < 1) throw Object.assign(new Error('工作区必须至少保留一名可用管理员'), { status: 409 });
          if (enable) delete target.disabledAt; else target.disabledAt = now; target.updatedAt = now;
          let sessionsRevoked = 0; let apiKeysRevoked = 0;
          if (!enable) {
            const before = data.sessions.length; data.sessions = data.sessions.filter(item => item.userId !== target.userId || item.workspaceId !== workspaceId); sessionsRevoked = before - data.sessions.length;
            for (const key of data.apiKeys.filter(item => item.workspaceId === workspaceId && item.createdByUserId === target.userId && !item.revokedAt)) { key.revokedAt = now; apiKeysRevoked += 1; }
          }
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: enable ? 'member.enabled' : 'member.disabled', entityType: 'membership', entityId: target.id, details: { userId: target.userId, sessionsRevoked, apiKeysRevoked }, at: now });
          return { membershipId: target.id, userId: target.userId, disabledAt: target.disabledAt || null, sessionsRevoked, apiKeysRevoked };
        });
        return json(res, 200, changed);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'members' && segments[2] && segments[3] === 'sessions' && segments[4] === 'revoke') {
        requireRole(['owner']); const now = new Date().toISOString();
        const revoked = await store.update(data => {
          const target = data.memberships.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!target) throw Object.assign(new Error('成员不存在'), { status: 404 });
          if (target.userId === currentUser.id) throw Object.assign(new Error('请在账户安全中管理自己的设备'), { status: 400 });
          const before = data.sessions.length; data.sessions = data.sessions.filter(item => item.userId !== target.userId || item.workspaceId !== workspaceId); const sessionsRevoked = before - data.sessions.length;
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'member.sessions_revoked', entityType: 'user', entityId: target.userId, details: { membershipId: target.id, sessionsRevoked }, at: now });
          return { membershipId: target.id, userId: target.userId, sessionsRevoked, revokedAt: now };
        });
        return json(res, 200, revoked);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'members' && segments[2] && segments[3] === 'mfa' && segments[4] === 'reset') {
        requireRole(['owner']); const now = new Date().toISOString();
        const reset = await store.update(data => {
          const target = data.memberships.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!target) throw Object.assign(new Error('成员不存在'), { status: 404 });
          if (target.userId === currentUser.id) throw Object.assign(new Error('请在账户安全中管理自己的两步验证'), { status: 400 });
          if (data.memberships.filter(item => item.userId === target.userId).length > 1) throw Object.assign(new Error('该账号属于多个工作区，请由账号本人重置两步验证'), { status: 409 });
          const user = data.users.find(item => item.id === target.userId); if (!user.mfaSecretEncrypted) throw Object.assign(new Error('该成员尚未启用两步验证'), { status: 409 });
          delete user.mfaSecretEncrypted; delete user.mfaRecoveryCodeHashes; delete user.mfaEnabledAt; delete user.mfaPendingSecretEncrypted; delete user.mfaPendingCreatedAt;
          const before = data.sessions.length; data.sessions = data.sessions.filter(item => item.userId !== target.userId); data.mfaChallenges = data.mfaChallenges.filter(item => item.userId !== target.userId); const sessionsRevoked = before - data.sessions.length;
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'member.mfa_reset', entityType: 'user', entityId: target.userId, details: { membershipId: target.id, sessionsRevoked }, at: now });
          return { membershipId: target.id, userId: target.userId, mfaEnabled: false, sessionsRevoked, resetAt: now };
        });
        return json(res, 200, reset);
      }
      if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'members' && segments[2]) {
        requireRole(['owner']);
        const input = await body(req); const role = input.role;
        if (!['owner', 'approver', 'member'].includes(role)) return json(res, 400, { error: '成员角色无效' });
        const changed = await store.update(data => {
          const target = data.memberships.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!target) throw Object.assign(new Error('成员不存在'), { status: 404 });
          if (target.role === 'owner' && role !== 'owner' && data.memberships.filter(item => item.workspaceId === workspaceId && item.role === 'owner').length <= 1) throw Object.assign(new Error('工作区必须至少保留一名管理员'), { status: 409 });
          const previousRole = target.role; target.role = role; target.updatedAt = new Date().toISOString();
          if (previousRole !== role) appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'member.role_changed', entityType: 'membership', entityId: target.id, details: { userId: target.userId, from: previousRole, to: role }, at: target.updatedAt });
          const user = data.users.find(item => item.id === target.userId); return { ...publicUser(user), role: target.role, membershipId: target.id };
        });
        return json(res, 200, changed);
      }
      if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'members' && segments[2]) {
        requireRole(['owner']);
        const removed = await store.update(data => {
          const target = data.memberships.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!target) throw Object.assign(new Error('成员不存在'), { status: 404 });
          if (target.role === 'owner' && data.memberships.filter(item => item.workspaceId === workspaceId && item.role === 'owner').length <= 1) throw Object.assign(new Error('工作区必须至少保留一名管理员'), { status: 409 });
          const at = new Date().toISOString(); data.memberships = data.memberships.filter(item => item.id !== target.id);
          data.sessions = data.sessions.filter(item => item.userId !== target.userId || item.workspaceId !== workspaceId);
          data.projectSelections = data.projectSelections.filter(item => item.userId !== target.userId || item.workspaceId !== workspaceId);
          let revokedApiKeys = 0; for (const key of data.apiKeys.filter(item => item.workspaceId === workspaceId && item.createdByUserId === target.userId && !item.revokedAt)) { key.revokedAt = at; revokedApiKeys += 1; }
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'member.removed', entityType: 'membership', entityId: target.id, details: { userId: target.userId, role: target.role, revokedApiKeys }, at });
          return { membershipId: target.id, userId: target.userId, self: target.userId === currentUser.id, revokedApiKeys };
        });
        return json(res, 200, removed, removed.self ? { 'set-cookie': clearSessionCookie(secureCookie) } : {});
      }
      if (req.method === 'GET' && url.pathname === '/api/backups') {
        requireRole(['owner']); const items = await backupManager.list();
        const drills = authData.recoveryDrills.filter(item => item.workspaceId === workspaceId).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
        return json(res, 200, { available: backupManager.available, drillAvailable: Boolean(backupManager.drillAvailable), reason: backupManager.available ? null : '可视化备份仅支持 PostgreSQL 部署', verifiedBackupAt, drills, items });
      }
      if (req.method === 'POST' && url.pathname === '/api/backups') {
        requireRole(['owner']); const created = await backupManager.create();
        await store.update(data => { appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'backup.created', entityType: 'backup', entityId: created.id, details: { applicationVersion: created.applicationVersion, schemaVersion: created.schemaVersion, evidenceFiles: created.evidenceFiles } }); });
        return json(res, 201, created);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'backups' && segments[2] && segments[3] === 'verify') {
        requireRole(['owner']); const verified = await backupManager.verify(segments[2]); verifiedBackupAt = verified.verifiedAt;
        await store.update(data => { appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'backup.verified', entityType: 'backup', entityId: verified.id, details: { filesVerified: verified.filesVerified, applicationVersion: verified.applicationVersion, schemaVersion: verified.schemaVersion }, at: verified.verifiedAt }); });
        return json(res, 200, verified);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'backups' && segments[2] && segments[3] === 'restore-preflight') {
        requireRole(['owner']); const input = await body(req); if (input.confirmation !== `预检恢复 ${segments[2]}`) return json(res, 400, { error: `请输入“预检恢复 ${segments[2]}”确认` });
        const preflight = await backupManager.restorePreflight(segments[2]); verifiedBackupAt = preflight.verifiedAt;
        await store.update(data => { appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'backup.restore_preflighted', entityType: 'backup', entityId: preflight.id, details: { canRestore: preflight.canRestore, schemaCompatible: preflight.schemaCompatible, applicationVersion: preflight.applicationVersion, schemaVersion: preflight.schemaVersion }, at: preflight.verifiedAt }); });
        return json(res, 200, preflight);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'backups' && segments[2] && segments[3] === 'drill') {
        requireRole(['owner']); const input = await body(req); if (input.confirmation !== `演练恢复 ${segments[2]}`) return json(res, 400, { error: `请输入“演练恢复 ${segments[2]}”确认` });
        const result = await backupManager.drill(segments[2]); const recorded = await store.update(data => { const item = { id: createId('rdr'), workspaceId, performedByUserId: currentUser.id, ...result }; data.recoveryDrills.unshift(item); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'backup.recovery_drilled', entityType: 'recovery_drill', entityId: item.id, details: { backupId: item.backupId, status: item.status, schemaVersion: item.schemaVersion, filesVerified: item.filesVerified, counts: item.counts }, at: item.completedAt }); return item; });
        return json(res, 201, recorded);
      }
      if (req.method === 'GET' && url.pathname === '/api/system/status') {
        requireRole(['owner', 'approver']);
        const now = Date.now(); const workspaceRuns = authData.runs.filter(item => item.workspaceId === workspaceId); const deliveries = authData.webhookDeliveries.filter(item => item.workspaceId === workspaceId); const workspaceAudit = authData.auditEvents.filter(item => item.workspaceId === workspaceId);
        return json(res, 200, {
          version, storage: await store.health(), audit: verifyAuditChain(workspaceAudit),
          members: authData.memberships.filter(item => item.workspaceId === workspaceId).length,
          runs: { queued: workspaceRuns.filter(item => item.status === 'queued').length, running: workspaceRuns.filter(item => item.status === 'running').length, failed: workspaceRuns.filter(item => item.status === 'failed').length, stale: workspaceRuns.filter(item => item.status === 'running' && now - new Date(item.startedAt || 0).getTime() > 15 * 60_000).length },
          webhooks: { pending: deliveries.filter(item => ['queued', 'retrying', 'sending'].includes(item.status)).length, failed: deliveries.filter(item => item.status === 'failed').length },
          checkedAt: new Date(now).toISOString()
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/security/reviews') {
        requireRole(['owner', 'approver']);
        const reviews = authData.securityReviews.filter(item => item.workspaceId === workspaceId).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
        return json(res, 200, reviews.map(review => { const findings = authData.securityFindings.filter(item => item.workspaceId === workspaceId && item.reviewId === review.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); const sourceUpdatedAt = [review.createdAt, ...findings.map(item => item.updatedAt)].sort().at(-1); const dossier = authData.signedSecurityReviews.filter(item => item.workspaceId === workspaceId && item.reviewId === review.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; return { ...review, findings, dossier: dossier ? { id: dossier.id, createdAt: dossier.createdAt, sourceUpdatedAt: dossier.payload.sourceUpdatedAt, current: dossier.payload.sourceUpdatedAt === sourceUpdatedAt } : null }; }));
      }
      if (req.method === 'POST' && url.pathname === '/api/security/reviews') {
        requireRole(['owner']); const input = await body(req); const reviewedAt = new Date(input.reviewedAt); const now = new Date();
        if (!Number.isFinite(reviewedAt.getTime()) || reviewedAt > new Date(now.getTime() + 24 * 60 * 60_000)) return json(res, 400, { error: '安全评审日期无效' });
        const suppliedFindings = Array.isArray(input.findings) ? input.findings : [];
        if (suppliedFindings.length > 100) return json(res, 400, { error: '单次最多登记 100 个安全发现' });
        const created = await store.update(data => {
          const at = now.toISOString(); const review = { id: createId('srev'), workspaceId, provider: required(input.provider, '评审机构', 200), reference: required(input.reference, '报告编号', 300), reviewedAt: reviewedAt.toISOString(), scope: required(input.scope, '评审范围', 2000), summary: required(input.summary, '评审摘要', 5000), createdByUserId: currentUser.id, createdAt: at };
          data.securityReviews.unshift(review); const findings = suppliedFindings.map((item, index) => {
            const severity = String(item.severity || '').toLowerCase(); if (!['critical', 'high', 'medium', 'low'].includes(severity)) throw Object.assign(new Error(`第 ${index + 1} 个发现的严重级别无效`), { status: 400 });
            return { id: createId('sec'), workspaceId, reviewId: review.id, severity, title: required(item.title, `第 ${index + 1} 个发现标题`, 500), description: required(item.description, `第 ${index + 1} 个发现说明`, 5000), remediation: String(item.remediation || '').trim().slice(0, 5000), status: 'open', createdAt: at, updatedAt: at };
          });
          data.securityFindings.unshift(...findings); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'security.review_recorded', entityType: 'security_review', entityId: review.id, details: { provider: review.provider, reference: review.reference, reviewedAt: review.reviewedAt, findings: findings.length }, at }); return { ...review, findings };
        });
        return json(res, 201, created);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'security' && segments[2] === 'reviews' && segments[3] && segments[4] === 'sign') {
        requireRole(['owner', 'approver']);
        const signed = await store.update(data => {
          const review = data.securityReviews.find(item => item.id === segments[3] && item.workspaceId === workspaceId); if (!review) throw Object.assign(new Error('安全评审不存在'), { status: 404 });
          const workspace = data.workspaces.find(item => item.id === workspaceId); workspace.signingKey ||= createSigningKey(signingSecret); const at = new Date().toISOString();
          const snapshot = securityReviewSnapshot(data, review, workspaceId, new Date(at)); const payload = { schema: 'shipwitness.security-review.v1', workspace: { id: workspace.id, name: workspace.name }, ...snapshot, signedAt: at };
          const document = { id: createId('ssr'), schema: 'shipwitness.signed-security-review.v1', workspaceId, reviewId: review.id, payload, signature: signPayload(payload, workspace.signingKey, signingSecret), createdByUserId: currentUser.id, createdAt: at };
          data.signedSecurityReviews.unshift(document); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'security.review_signed', entityType: 'signed_security_review', entityId: document.id, details: { reviewId: review.id, reference: review.reference, findings: snapshot.summary.total, unresolved: snapshot.summary.unresolved }, at }); return document;
        });
        return json(res, 201, { ...signed, valid: verifySignedPayload(signed.payload, signed.signature) });
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'security-review-dossiers' && segments[2]) {
        const document = authData.signedSecurityReviews.find(item => item.id === segments[2] && item.workspaceId === workspaceId); return document ? json(res, 200, { ...document, valid: verifySignedPayload(document.payload, document.signature) }) : json(res, 404, { error: '安全整改证据包不存在' });
      }
      if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'security' && segments[2] === 'findings' && segments[3]) {
        requireRole(['owner', 'approver']); const input = await body(req); const allowed = ['open', 'remediating', 'fixed_pending_retest', 'verified', 'risk_accepted'];
        if (!allowed.includes(input.status)) return json(res, 400, { error: '安全发现状态无效' });
        if (input.status === 'risk_accepted' && membership.role !== 'owner') return json(res, 403, { error: '只有管理员可以接受安全风险' });
        const updated = await store.update(data => {
          const finding = data.securityFindings.find(item => item.id === segments[3] && item.workspaceId === workspaceId); if (!finding) throw Object.assign(new Error('安全发现不存在'), { status: 404 });
          const at = new Date().toISOString(); const previous = finding.status;
          if (input.status === 'verified') { finding.retestEvidence = required(input.evidence, '复测证据', 5000); finding.verifiedAt = at; finding.verifiedByUserId = currentUser.id; finding.riskAcceptance = null; }
          if (input.status === 'risk_accepted') {
            const expiresAt = new Date(input.expiresAt); if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date() || expiresAt > new Date(Date.now() + 90 * 86400_000)) throw Object.assign(new Error('风险接受到期日必须在未来 90 天内'), { status: 400 });
            finding.riskAcceptance = { rationale: required(input.rationale, '风险接受原因', 2000), expiresAt: expiresAt.toISOString(), acceptedAt: at, acceptedByUserId: currentUser.id }; finding.retestEvidence = null;
          }
          if (!['verified', 'risk_accepted'].includes(input.status)) { finding.riskAcceptance = null; finding.retestEvidence = null; }
          finding.status = input.status; finding.updatedAt = at; appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'security.finding_status_changed', entityType: 'security_finding', entityId: finding.id, details: { reviewId: finding.reviewId, severity: finding.severity, from: previous, to: finding.status, riskExpiresAt: finding.riskAcceptance?.expiresAt || null }, at }); return finding;
        });
        return json(res, 200, updated);
      }
      if (req.method === 'GET' && url.pathname === '/api/readiness') {
        requireRole(['owner']);
        const now = new Date(); const storage = await store.health(); const workspaceAudit = authData.auditEvents.filter(item => item.workspaceId === workspaceId); const audit = verifyAuditChain(workspaceAudit);
        let masterKeyValid = false; try { keyFromSecret(signingSecret); masterKeyValid = true; } catch {}
        const publicHttps = Boolean(publicUrl && new URL(publicUrl).protocol === 'https:');
        const backupTime = verifiedBackupAt ? new Date(verifiedBackupAt) : null; const backupAgeHours = backupTime ? (now.getTime() - backupTime.getTime()) / 3_600_000 : null; const backupFresh = Number.isFinite(backupAgeHours) && backupAgeHours >= -0.1 && backupAgeHours <= 24;
        const latestRecoveryDrill = authData.recoveryDrills.filter(item => item.workspaceId === workspaceId && item.status === 'passed').sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0]; const drillAgeDays = latestRecoveryDrill ? (now.getTime() - new Date(latestRecoveryDrill.completedAt).getTime()) / 86_400_000 : null; const drillFresh = Number.isFinite(drillAgeDays) && drillAgeDays >= -0.1 && drillAgeDays <= 90;
        const recordedReview = authData.securityReviews.filter(item => item.workspaceId === workspaceId).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0];
        const effectiveReviewReference = recordedReview?.reference || securityReviewReference; const effectiveReviewedAt = recordedReview?.reviewedAt || securityReviewedAt;
        const reviewTime = effectiveReviewedAt ? new Date(effectiveReviewedAt) : null; const reviewAgeDays = reviewTime ? (now.getTime() - reviewTime.getTime()) / 86_400_000 : null; const securityReviewFresh = Boolean(effectiveReviewReference && Number.isFinite(reviewAgeDays) && reviewAgeDays >= -0.1 && reviewAgeDays <= 365);
        const reviewFindings = recordedReview ? authData.securityFindings.filter(item => item.workspaceId === workspaceId && item.reviewId === recordedReview.id) : [];
        const reviewSourceUpdatedAt = recordedReview ? [recordedReview.createdAt, ...reviewFindings.map(item => item.updatedAt)].sort().at(-1) : null; const signedSecurityReview = recordedReview ? authData.signedSecurityReviews.filter(item => item.workspaceId === workspaceId && item.reviewId === recordedReview.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : null; const signedSecurityReviewCurrent = Boolean(signedSecurityReview && signedSecurityReview.payload.sourceUpdatedAt === reviewSourceUpdatedAt && verifySignedPayload(signedSecurityReview.payload, signedSecurityReview.signature));
        const activeFinding = item => item.status !== 'verified' && !(item.status === 'risk_accepted' && new Date(item.riskAcceptance?.expiresAt) > now);
        const blockingSecurityFindings = reviewFindings.filter(item => ['critical', 'high'].includes(item.severity) && activeFinding(item)); const acceptedBlockingFindings = reviewFindings.filter(item => ['critical', 'high'].includes(item.severity) && item.status === 'risk_accepted' && !activeFinding(item)); const advisorySecurityFindings = reviewFindings.filter(item => ['medium', 'low'].includes(item.severity) && activeFinding(item));
        const releaseSupport = releaseSupportStatus({ version, releasedAt, endOfSupportAt, now });
        const workspaceRuns = authData.runs.filter(item => item.workspaceId === workspaceId); const staleRuns = workspaceRuns.filter(item => item.status === 'running' && now.getTime() - new Date(item.startedAt || 0).getTime() > 15 * 60_000).length;
        const webhookFailures = authData.webhookDeliveries.filter(item => item.workspaceId === workspaceId && item.status === 'failed').length; const emailFailures = authData.emailDeliveries.filter(item => item.workspaceId === workspaceId && item.status === 'failed').length;
        const githubProjects = authData.projects.filter(item => item.workspaceId === workspaceId && !item.archivedAt && item.githubRepo).length;
        const acceptanceSecretStates = authData.acceptanceSecrets.filter(item => item.workspaceId === workspaceId).map(item => acceptanceSecretLifecycle(item, now.getTime())); const expiredAcceptanceSecrets = acceptanceSecretStates.filter(item => item.status === 'expired').length; const expiringAcceptanceSecrets = acceptanceSecretStates.filter(item => item.status === 'expiring').length;
        const privilegedUserIds = new Set(authData.memberships.filter(item => item.workspaceId === workspaceId && ['owner', 'approver'].includes(item.role)).map(item => item.userId)); const privilegedWithoutMfa = authData.users.filter(item => privilegedUserIds.has(item.id) && !item.mfaSecretEncrypted).length;
        const checks = [
          { id: 'postgres', category: '基础设施', label: '生产数据库', status: String(storage.engine || '').toLowerCase().startsWith('postgresql') ? 'pass' : 'block', detail: String(storage.engine || '').toLowerCase().startsWith('postgresql') ? 'PostgreSQL 已连接并通过健康检查。' : '当前仍使用本地 JSON 文件，正式部署必须切换 PostgreSQL。', action: String(storage.engine || '').toLowerCase().startsWith('postgresql') ? null : '配置 DATABASE_URL 并执行迁移' },
          { id: 'https', category: '访问安全', label: 'HTTPS 公网地址', status: publicHttps ? 'pass' : 'block', detail: publicHttps ? '已配置外部 HTTPS 地址，邀请和任务链接可安全生成。' : '未配置有效的 SHIPWITNESS_PUBLIC_URL HTTPS 地址。', action: publicHttps ? null : '在反向代理启用 HTTPS，并配置 SHIPWITNESS_PUBLIC_URL' },
          { id: 'master_key', category: '访问安全', label: '主密钥', status: masterKeyValid ? 'pass' : 'block', detail: masterKeyValid ? '32 字节 Base64 主密钥格式有效。' : '主密钥缺失或格式无效，签名和加密材料无法安全工作。', action: masterKeyValid ? null : '生成并安全保存 SHIPWITNESS_MASTER_KEY' },
          { id: 'privileged_mfa', category: '访问安全', label: '高权限账号两步验证', status: privilegedWithoutMfa ? 'warning' : 'pass', detail: privilegedWithoutMfa ? `${privilegedWithoutMfa} 个管理员或审批人尚未启用两步验证。` : `${privilegedUserIds.size} 个高权限账号均已启用两步验证。`, action: privilegedWithoutMfa ? '请管理员和审批人在账户安全中绑定 TOTP 验证器' : null },
          { id: 'acceptance_credentials', category: '访问安全', label: '验收凭据生命周期', status: expiredAcceptanceSecrets || expiringAcceptanceSecrets ? 'warning' : 'pass', detail: expiredAcceptanceSecrets ? `${expiredAcceptanceSecrets} 个验收凭据已过期并停止执行。` : expiringAcceptanceSecrets ? `${expiringAcceptanceSecrets} 个验收凭据将在 14 天内到期。` : '没有已过期或即将到期的验收凭据。', action: expiredAcceptanceSecrets || expiringAcceptanceSecrets ? '在验收凭据保险箱中完成轮换' : null },
          { id: 'audit', category: '证据治理', label: '审计链完整性', status: audit.valid ? 'pass' : 'block', detail: audit.valid ? `${audit.checked} 条审计事件哈希链完整。` : `审计链异常：${audit.brokenEventId ? `事件 ${audit.brokenEventId}` : '完整性校验失败'}`, action: audit.valid ? null : '停止发布并调查审计链异常' },
          { id: 'backup', category: '灾备恢复', label: '24 小时内验证备份', status: backupFresh ? 'pass' : 'warning', detail: backupFresh ? `最近验证备份距今 ${backupAgeHours.toFixed(1)} 小时。` : '服务无法确认最近 24 小时内存在已验证备份。', action: backupFresh ? null : '运行 backup、backup:verify，并注入 SHIPWITNESS_LAST_VERIFIED_BACKUP_AT' },
          { id: 'recovery_drill', category: '灾备恢复', label: '90 天内隔离恢复演练', status: drillFresh ? 'pass' : 'warning', detail: drillFresh ? `最近恢复演练距今 ${drillAgeDays.toFixed(0)} 天，数据库与核心记录核验通过。` : '尚无最近 90 天内通过的隔离数据库恢复演练。', action: drillFresh ? null : '配置 SHIPWITNESS_DRILL_DATABASE_URL，并在备份中心执行恢复演练' },
          { id: 'security_review', category: '访问安全', label: '一年内外部安全评审', status: securityReviewFresh ? 'pass' : 'warning', detail: securityReviewFresh ? `独立安全评审距今 ${reviewAgeDays.toFixed(0)} 天，参考编号已登记。` : effectiveReviewReference ? '已登记评审参考，但评审日期缺失、无效或超过一年。' : '尚未登记独立安全评审结果。', action: securityReviewFresh ? null : '在安全评审中心登记报告与完成日期，或配置对应部署证据' },
          { id: 'security_findings', category: '访问安全', label: '安全发现整改', status: blockingSecurityFindings.length ? 'block' : acceptedBlockingFindings.length || advisorySecurityFindings.length ? 'warning' : 'pass', detail: blockingSecurityFindings.length ? `${blockingSecurityFindings.length} 个严重或高危发现尚未通过复测。` : acceptedBlockingFindings.length || advisorySecurityFindings.length ? `${acceptedBlockingFindings.length} 个严重风险临时接受，${advisorySecurityFindings.length} 个中低风险待处理。` : recordedReview ? `${reviewFindings.length} 个发现均已关闭或评审未发现问题。` : '尚无结构化安全发现；登记评审后系统会跟踪整改与复测。', action: blockingSecurityFindings.length ? '修复严重和高危发现并登记复测证据' : acceptedBlockingFindings.length || advisorySecurityFindings.length ? '在风险接受到期前完成修复，并处理剩余中低风险' : null },
          { id: 'security_evidence', category: '证据治理', label: '签名安全整改证据包', status: !recordedReview || signedSecurityReviewCurrent ? 'pass' : 'warning', detail: !recordedReview ? '当前使用部署侧评审元数据；结构化登记后可生成签名证据包。' : signedSecurityReviewCurrent ? `当前评审状态已签名封存，证据包 ${signedSecurityReview.id}。` : signedSecurityReview ? '发现项状态在最近签署后发生变化，需要重新生成证据包。' : '当前安全评审尚未生成可离线验证的签名证据包。', action: recordedReview && !signedSecurityReviewCurrent ? '在安全评审中心重新生成签名证据包' : null },
          { id: 'support_lifecycle', category: '版本治理', label: '版本支持周期', status: releaseSupport.status === 'supported' ? 'pass' : releaseSupport.channel === 'stable' ? 'block' : 'warning', detail: releaseSupport.reason, action: releaseSupport.status === 'supported' ? null : releaseSupport.channel === 'stable' ? '升级到仍在支持周期内的稳定版本' : '正式公网发布前升级到带发布日期和停止支持日期的 1.x 稳定版本' },
          { id: 'email', category: '通知送达', label: '邮件通知', status: emailEnabled && emailFailures === 0 ? 'pass' : 'warning', detail: !emailEnabled ? 'SMTP 未启用，邀请、失败和审批需要成员主动查看。' : emailFailures ? `${emailFailures} 封邮件最终投递失败。` : 'SMTP 已启用且没有最终失败投递。', action: !emailEnabled ? '配置 TLS SMTP 并发送测试邮件' : emailFailures ? '处理失败邮件并重试' : null },
          { id: 'github_webhook', category: '代码证据', label: 'GitHub 自动同步', status: !githubProjects || githubWebhookSecret ? 'pass' : 'warning', detail: !githubProjects ? '当前没有项目启用 GitHub 集成。' : githubWebhookSecret ? `${githubProjects} 个 GitHub 项目已启用签名事件接收。` : `${githubProjects} 个 GitHub 项目仍依赖人工同步。`, action: githubProjects && !githubWebhookSecret ? '配置 SHIPWITNESS_GITHUB_WEBHOOK_SECRET 并在仓库订阅事件' : null },
          { id: 'operations', category: '运行健康', label: '任务与 Webhook', status: staleRuns || webhookFailures ? 'warning' : 'pass', detail: staleRuns || webhookFailures ? `${staleRuns} 个超时任务，${webhookFailures} 个 Webhook 最终失败。` : '没有超时任务或最终失败 Webhook。', action: staleRuns || webhookFailures ? '在告警中心确认并处理异常' : null },
          { id: 'target_policy', category: '执行边界', label: '验收目标白名单', status: 'pass', detail: `${allowedTargetOrigins.length} 个外部来源已明确允许；其他非本机来源默认拒绝。`, action: null }
        ];
        const blockers = checks.filter(item => item.status === 'block').length; const warnings = checks.filter(item => item.status === 'warning').length;
        const level = blockers ? 'local_only' : warnings ? 'pilot_ready' : 'production_candidate';
        const labels = { local_only: '仅限本地或开发环境', pilot_ready: '可进入受控试点', production_candidate: '具备公网候选条件' };
        return json(res, 200, { schema: 'shipwitness.readiness.v1', version, generatedAt: now.toISOString(), verdict: { level, label: labels[level], blockers, warnings, passed: checks.length - blockers - warnings }, checks });
      }
      if (req.method === 'POST' && url.pathname === '/api/alerts/refresh') {
        requireRole(['owner', 'approver']);
        const alerts = await store.update(data => refreshAlerts(data, workspaceId, currentUser.id));
        return json(res, 200, alerts);
      }
      if (req.method === 'GET' && url.pathname === '/api/alerts') {
        requireRole(['owner', 'approver']);
        const status = url.searchParams.get('status');
        const alerts = authData.alerts.filter(item => item.workspaceId === workspaceId && (!status || item.status === status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return json(res, 200, alerts);
      }
      if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'alerts' && segments[2]) {
        requireRole(['owner', 'approver']);
        const input = await body(req);
        if (!['acknowledged', 'resolved'].includes(input.status)) return json(res, 400, { error: '告警状态无效' });
        const changed = await store.update(data => {
          const alert = data.alerts.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!alert) throw Object.assign(new Error('告警不存在'), { status: 404 });
          const now = new Date().toISOString();
          if (input.status === 'resolved' && alertSignals(data, workspaceId).some(item => item.sourceKey === alert.sourceKey)) throw Object.assign(new Error('异常条件仍然存在，暂时不能解决此告警'), { status: 409 });
          alert.status = input.status;
          if (input.status === 'acknowledged') { alert.acknowledgedAt = now; alert.acknowledgedByUserId = currentUser.id; }
          else { alert.resolvedAt = now; alert.resolvedByUserId = currentUser.id; alert.resolution = required(input.resolution, '解决说明', 500); }
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: `alert.${input.status}`, entityType: 'alert', entityId: alert.id, details: { sourceKey: alert.sourceKey }, at: now });
          return alert;
        });
        return json(res, 200, changed);
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
      if (req.method === 'POST' && url.pathname === '/api/audit-exports') {
        requireRole(['owner', 'approver']);
        const created = await store.update(data => {
          const events = data.auditEvents.filter(item => item.workspaceId === workspaceId).sort((a, b) => a.sequence - b.sequence);
          const workspace = data.workspaces.find(item => item.id === workspaceId); const now = new Date().toISOString();
          const actors = Object.fromEntries([...new Set(events.map(item => item.actorUserId).filter(Boolean))].map(id => { const user = data.users.find(item => item.id === id); return [id, user ? publicUser(user) : { id, name: '未知用户', email: '' }]; }));
          const document = { schema: 'shipwitness.audit-export.v1', workspace: { id: workspace.id, name: workspace.name }, generatedAt: now, generatedByUserId: currentUser.id, integrity: verifyAuditChain(events), actors, events };
          const item = { id: createId('aex'), workspaceId, createdByUserId: currentUser.id, createdAt: now, eventCount: events.length, headHash: document.integrity.headHash, document };
          data.auditExports.unshift(item); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'audit.exported', entityType: 'audit_export', entityId: item.id, details: { eventCount: item.eventCount, headHash: item.headHash }, at: now }); return item;
        });
        return json(res, 201, { id: created.id, createdAt: created.createdAt, eventCount: created.eventCount, headHash: created.headHash, downloadUrl: `/api/audit-exports/${created.id}/download` });
      }
      if (req.method === 'GET' && url.pathname === '/api/audit-exports') {
        requireRole(['owner', 'approver']);
        return json(res, 200, authData.auditExports.filter(item => item.workspaceId === workspaceId).map(({ document: hidden, ...item }) => ({ ...item, downloadUrl: `/api/audit-exports/${item.id}/download` })));
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'audit-exports' && segments[2] && segments[3] === 'download') {
        requireRole(['owner', 'approver']);
        const item = authData.auditExports.find(value => value.id === segments[2] && value.workspaceId === workspaceId);
        if (!item) return json(res, 404, { error: '审计导出不存在' });
        const content = `${JSON.stringify(item.document, null, 2)}\n`;
        res.writeHead(200, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="shipwitness-audit-${item.id}.json"`, 'cache-control': 'no-store' });
        return res.end(content);
      }
      if (req.method === 'GET' && url.pathname === '/api/retention') {
        requireRole(['owner']);
        return json(res, 200, { operationalDays: currentWorkspace.retention?.operationalDays || 90, immutable: ['auditEvents', 'runs', 'issues', 'decisions', 'signedDossiers', 'evidence'] });
      }
      if (req.method === 'PUT' && url.pathname === '/api/retention') {
        requireRole(['owner']);
        const input = await body(req); const operationalDays = Number(input.operationalDays);
        if (!Number.isInteger(operationalDays) || operationalDays < 30 || operationalDays > 730) return json(res, 400, { error: '运营数据保留天数必须是 30 到 730 的整数' });
        const policy = await store.update(data => {
          const workspace = data.workspaces.find(item => item.id === workspaceId); const previous = workspace.retention?.operationalDays || 90; const now = new Date().toISOString();
          workspace.retention = { operationalDays, updatedAt: now, updatedByUserId: currentUser.id };
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'retention.updated', entityType: 'workspace', entityId: workspaceId, details: { previousOperationalDays: previous, operationalDays }, at: now }); return workspace.retention;
        });
        return json(res, 200, policy);
      }
      if (req.method === 'GET' && url.pathname === '/api/retention/preview') {
        requireRole(['owner']);
        const preview = retentionPreview(authData, workspaceId);
        const { ids: hidden, ...safe } = preview; return json(res, 200, safe);
      }
      if (req.method === 'POST' && url.pathname === '/api/retention/cleanup') {
        requireRole(['owner']);
        const input = await body(req); const asOf = new Date(input.asOf);
        if (!Number.isFinite(asOf.getTime()) || Math.abs(Date.now() - asOf.getTime()) > 10 * 60_000) return json(res, 400, { error: '清理预览已过期，请重新预览' });
        const result = await store.update(data => {
          const preview = retentionPreview(data, workspaceId, asOf);
          if (input.token !== preview.token) throw Object.assign(new Error('数据已经变化，请重新预览后再清理'), { status: 409 });
          if (!preview.total) throw Object.assign(new Error('没有符合条件的运营数据'), { status: 409 });
          const sessionIds = new Set(preview.ids.sessions); const deliveryIds = new Set(preview.ids.webhookDeliveries); const emailDeliveryIds = new Set(preview.ids.emailDeliveries); const githubDeliveryIds = new Set(preview.ids.githubDeliveries); const idempotencyRecordIds = new Set(preview.ids.idempotencyRecords); const alertIds = new Set(preview.ids.alerts); const invitationIds = new Set(preview.ids.invitations);
          data.sessions = data.sessions.filter(item => !sessionIds.has(item.id)); data.webhookDeliveries = data.webhookDeliveries.filter(item => !deliveryIds.has(item.id)); data.emailDeliveries = data.emailDeliveries.filter(item => !emailDeliveryIds.has(item.id)); data.githubDeliveries = data.githubDeliveries.filter(item => !githubDeliveryIds.has(item.id)); data.idempotencyRecords = data.idempotencyRecords.filter(item => !idempotencyRecordIds.has(item.id)); data.alerts = data.alerts.filter(item => !alertIds.has(item.id)); data.invitations = data.invitations.filter(item => !invitationIds.has(item.id));
          const now = new Date().toISOString(); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'retention.cleaned', entityType: 'workspace', entityId: workspaceId, details: { cutoff: preview.cutoff, counts: preview.counts, total: preview.total }, at: now });
          return { cleanedAt: now, cutoff: preview.cutoff, counts: preview.counts, total: preview.total };
        });
        return json(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/api/api-keys') {
        requireRole(['owner']);
        return json(res, 200, authData.apiKeys.filter(item => item.workspaceId === workspaceId).map(({ tokenHash: hidden, ...item }) => item));
      }
      if (req.method === 'POST' && url.pathname === '/api/api-keys') {
        requireRole(['owner']);
        const input = await body(req); const scopes = Array.isArray(input.scopes) ? [...new Set(input.scopes)] : ['gate:read']; const allowedScopes = ['gate:read', 'dossier:read', 'acceptance:read', 'acceptance:write'];
        if (!scopes.length || scopes.some(scope => !allowedScopes.includes(scope))) return json(res, 400, { error: 'API Key 作用域无效' });
        const secret = `swk_${randomBytes(32).toString('base64url')}`; const now = new Date().toISOString();
        const created = await store.update(data => {
          const item = { id: createId('key'), workspaceId, name: required(input.name, '名称'), tokenHash: sessionTokenHash(secret), tokenSuffix: secret.slice(-6), scopes, createdByUserId: currentUser.id, createdAt: now, lastUsedAt: null, revokedAt: null };
          data.apiKeys.unshift(item); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'api_key.created', entityType: 'api_key', entityId: item.id, details: { name: item.name, scopes }, at: now }); return item;
        });
        const { tokenHash: hidden, ...safe } = created;
        return json(res, 201, { ...safe, token: secret });
      }
      if (req.method === 'GET' && url.pathname === '/api/acceptance-secrets') {
        requireRole(['owner']);
        const activeProjectIds = new Set(authData.projects.filter(item => item.workspaceId === workspaceId && !item.archivedAt).map(item => item.id));
        const referenceCount = name => authData.contracts.filter(item => item.workspaceId === workspaceId && activeProjectIds.has(item.projectId) && item.enabled && (item.steps || []).some(step => step.secretRef === name)).length;
        return json(res, 200, authData.acceptanceSecrets.filter(item => item.workspaceId === workspaceId).map(({ encryptedValue: hidden, ...item }) => ({ ...item, ...acceptanceSecretLifecycle(item), referenceCount: referenceCount(item.name) })));
      }
      if (req.method === 'POST' && url.pathname === '/api/acceptance-secrets') {
        requireRole(['owner']); const input = await body(req); const name = required(input.name, '凭据名称', 64).toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) return json(res, 400, { error: '凭据名称必须以字母开头，只能包含大写字母、数字和下划线' });
        const value = required(input.value, '凭据值', 10_000); const expiresAt = acceptanceSecretExpiry(input); const created = await store.update(data => { if (data.acceptanceSecrets.some(item => item.workspaceId === workspaceId && item.name === name)) throw Object.assign(new Error('凭据名称已存在；请使用轮换功能更新'), { status: 409 }); const now = new Date().toISOString(); const item = { id: createId('asec'), workspaceId, name, encryptedValue: encryptSecret(value, signingSecret), expiresAt, createdByUserId: currentUser.id, createdAt: now, updatedAt: now }; data.acceptanceSecrets.push(item); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'acceptance_secret.created', entityType: 'acceptance_secret', entityId: item.id, details: { name, expiresAt }, at: now }); return item; });
        const { encryptedValue: hidden, ...safe } = created; return json(res, 201, safe);
      }
      if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'acceptance-secrets' && segments[2]) {
        requireRole(['owner']); const input = await body(req); const value = required(input.value, '新凭据值', 10_000); const expiresAt = acceptanceSecretExpiry(input);
        const rotated = await store.update(data => { const item = data.acceptanceSecrets.find(candidate => candidate.id === segments[2] && candidate.workspaceId === workspaceId); if (!item) throw Object.assign(new Error('验收凭据不存在'), { status: 404 }); const at = new Date().toISOString(); item.encryptedValue = encryptSecret(value, signingSecret); item.expiresAt = expiresAt; item.updatedAt = at; item.rotatedByUserId = currentUser.id; appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'acceptance_secret.rotated', entityType: 'acceptance_secret', entityId: item.id, details: { name: item.name, expiresAt }, at }); return item; });
        const { encryptedValue: hidden, ...safe } = rotated; return json(res, 200, safe);
      }
      if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'acceptance-secrets' && segments[2]) {
        requireRole(['owner']); const removed = await store.update(data => { const item = data.acceptanceSecrets.find(value => value.id === segments[2] && value.workspaceId === workspaceId); if (!item) throw Object.assign(new Error('验收凭据不存在'), { status: 404 }); const activeProjectIds = new Set(data.projects.filter(project => project.workspaceId === workspaceId && !project.archivedAt).map(project => project.id)); const references = data.contracts.filter(contract => contract.workspaceId === workspaceId && activeProjectIds.has(contract.projectId) && contract.enabled && (contract.steps || []).some(step => step.secretRef === item.name)); if (references.length) throw Object.assign(new Error(`仍有 ${references.length} 条启用的验收标准引用该凭据；请轮换凭据或先停用相关标准`), { status: 409 }); data.acceptanceSecrets = data.acceptanceSecrets.filter(value => value.id !== item.id); const at = new Date().toISOString(); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'acceptance_secret.deleted', entityType: 'acceptance_secret', entityId: item.id, details: { name: item.name }, at }); return { id: item.id, name: item.name, deletedAt: at }; }); return json(res, 200, removed);
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
      if (req.method === 'GET' && url.pathname === '/api/integrations/github') {
        requireRole(['owner', 'approver']);
        const deliveries = authData.githubDeliveries.filter(item => item.workspaceIds?.includes(workspaceId)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 50).map(item => githubDeliveryForWorkspace(item, workspaceId, authData.projects));
        return json(res, 200, { configured: Boolean(githubWebhookSecret), endpoint: `${publicUrl || ''}/api/integrations/github/webhook`, supportedEvents: ['push', 'check_suite', 'check_run', 'workflow_run'], deliveries });
      }
      if (req.method === 'GET' && url.pathname === '/api/deployment/configuration') {
        requireRole(['owner']);
        return json(res, 200, await deploymentConfiguration());
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'github-deliveries' && segments[2] && segments[3] === 'retry') {
        requireRole(['owner', 'approver']);
        const delivery = authData.githubDeliveries.find(item => item.id === segments[2] && item.workspaceIds?.includes(workspaceId));
        if (!delivery) return json(res, 404, { error: 'GitHub 事件不存在' });
        if (delivery.status !== 'failed') return json(res, 409, { error: '只有同步失败的 GitHub 事件可以重试' });
        const projectIds = delivery.projectIds.filter(id => authData.projects.some(project => project.id === id && project.workspaceId === workspaceId)); const results = [];
        for (const projectId of projectIds) {
          try { const status = await syncRepositoryProject({ projectId, actorUserId: currentUser.id, trigger: `github_retry:${delivery.event}` }); results.push({ projectId, status: 'synced', commitSha: status.commit.sha, checksState: status.checks.state }); }
          catch (error) { results.push({ projectId, status: 'failed', error: String(error.message || '同步失败').slice(0, 300) }); }
        }
        const updated = await store.update(data => { const current = data.githubDeliveries.find(item => item.id === delivery.id); const retriedIds = new Set(projectIds); current.results = [...(current.results || []).filter(item => !retriedIds.has(item.projectId)), ...results]; current.attempts = Number(current.attempts || 0) + 1; current.status = current.results.some(item => item.status === 'failed') ? 'failed' : 'synced'; current.updatedAt = new Date().toISOString(); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'github.delivery_retried', entityType: 'github_delivery', entityId: current.id, details: { deliveryId: current.deliveryId, projects: projectIds.length, status: current.status }, at: current.updatedAt }); return current; });
        return json(res, updated.status === 'synced' ? 200 : 202, githubDeliveryForWorkspace(updated, workspaceId, authData.projects));
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
      if (req.method === 'GET' && url.pathname === '/api/email/status') {
        requireRole(['owner']); const deliveries = authData.emailDeliveries.filter(item => item.workspaceId === workspaceId);
        return json(res, 200, { enabled: emailEnabled, publicUrlConfigured: Boolean(publicUrl), counts: { queued: deliveries.filter(item => ['queued', 'retrying', 'sending'].includes(item.status)).length, delivered: deliveries.filter(item => item.status === 'delivered').length, failed: deliveries.filter(item => item.status === 'failed').length } });
      }
      if (req.method === 'GET' && url.pathname === '/api/email-deliveries') {
        requireRole(['owner']);
        return json(res, 200, authData.emailDeliveries.filter(item => item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(({ encryptedMessage: hidden, to, ...item }) => ({ ...item, recipient: maskedEmail(to) })));
      }
      if (req.method === 'POST' && url.pathname === '/api/email/test') {
        requireRole(['owner']); if (!emailEnabled) return json(res, 409, { error: 'SMTP 邮件通知尚未配置' });
        const queued = await store.update(data => queueEmail(data, { workspaceId, to: currentUser.email, kind: 'configuration_test', entityId: currentUser.id, subject: 'ShipWitness 邮件通知测试', text: `来自 ${currentWorkspace.name} 的邮件通知配置测试已成功入队。`, html: `<p>来自 <strong>${htmlEscape(currentWorkspace.name)}</strong> 的邮件通知配置测试已成功入队。</p>` }));
        return json(res, 202, { id: queued.id, status: queued.status, recipient: maskedEmail(currentUser.email) });
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'email-deliveries' && segments[2] && segments[3] === 'retry') {
        requireRole(['owner']); if (!emailEnabled) return json(res, 409, { error: 'SMTP 邮件通知尚未配置' });
        const retried = await store.update(data => { const item = data.emailDeliveries.find(delivery => delivery.id === segments[2] && delivery.workspaceId === workspaceId); if (!item) throw Object.assign(new Error('邮件投递不存在'), { status: 404 }); if (item.status !== 'failed') throw Object.assign(new Error('只有最终失败的邮件才能手动重试'), { status: 409 }); item.status = 'retrying'; item.attempts = 0; item.nextAttemptAt = new Date().toISOString(); item.manualRetryAt = item.nextAttemptAt; item.lastError = null; appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'email.retried', entityType: 'email_delivery', entityId: item.id, details: { kind: item.kind }, at: item.manualRetryAt }); return item; });
        return json(res, 202, { id: retried.id, status: retried.status });
      }
      if (req.method === 'GET' && url.pathname === '/api/starter-kits') return json(res, 200, starterKits);
      if (req.method === 'POST' && url.pathname === '/api/starter-kits/apply') {
        const input = await body(req); const kit = starterKits.find(item => item.id === input.kitId);
        if (!kit) return json(res, 400, { error: '验收启动包无效' });
        const repoPath = required(input.repo, '项目目录', 4096);
        const targetUrl = validateTargetUrl(required(input.url, '测试网址', 2048), allowedTargetOrigins).href;
        const startPath = required(input.startPath || '/', '起始路径', 2048);
        if (!startPath.startsWith('/') || startPath.startsWith('//')) return json(res, 400, { error: '起始路径必须是站内路径，例如 / 或 /login' });
        const expectedText = required(input.expectedText, '预期页面文字', 500);
        const definitions = starterContracts({ kitId: kit.id, startPath, expectedText }).map(item => ({ ...item, steps: normalizeSteps(item.steps) }));
        const created = await store.update(data => {
          data.contracts ||= [];
          const now = new Date().toISOString();
          const project = { id: createId('prj'), workspaceId, name: required(input.name, '项目名称'), repo: repoPath, url: targetUrl, branch: required(input.branch || 'main', '代码分支', 255), handoffMode: input.handoffMode || 'file', githubRepo: String(input.githubRepo || '').trim(), starterKitId: kit.id, updatedAt: now, createdAt: now };
          data.projects.push(project);
          let preference = data.projectSelections.find(item => item.workspaceId === workspaceId && item.userId === currentUser.id); if (!preference) data.projectSelections.push({ id: createId('psl'), workspaceId, userId: currentUser.id, projectId: project.id, updatedAt: now }); else { preference.projectId = project.id; preference.updatedAt = now; }
          const contracts = definitions.map(item => ({ ...item, id: createId('ctr'), workspaceId, projectId: project.id, enabled: true, version: 1, createdAt: now, updatedAt: now }));
          data.contracts.unshift(...contracts);
          const criteria = contracts.map(item => ({ contractId: item.id, code: item.code, title: item.title, description: item.description, category: item.category, severity: item.severity, steps: structuredClone(item.steps), version: item.version, ...(item.sourceFeedbackId ? { sourceFeedbackId: item.sourceFeedbackId } : {}) }));
          const run = { id: createId('run'), workspaceId, projectId: project.id, requirement: required(input.requirement || `验证${project.name}的${kit.name}发布基线`, '原始需求'), criteria, status: 'queued', attemptNumber: 1, createdByUserId: currentUser.id, starterKitId: kit.id, createdAt: now };
          data.runs.unshift(run);
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'starter_kit.applied', entityType: 'project', entityId: project.id, details: { kitId: kit.id, contractCount: contracts.length, runId: run.id }, at: now });
          return { project, contracts, run, kit };
        });
        return json(res, 201, created);
      }
      if (req.method === 'GET' && url.pathname === '/api/projects/overview') {
        const data = await store.read();
        const projects = data.projects.filter(item => item.workspaceId === workspaceId && !item.archivedAt);
        const items = projects.map(project => {
          const runs = data.runs.filter(item => item.workspaceId === workspaceId && item.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          const latestRun = runs[0] || null;
          const decision = latestRun ? data.decisions.filter(item => item.workspaceId === workspaceId && item.runId === latestRun.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : null;
          const openIssues = data.issues.filter(item => item.workspaceId === workspaceId && item.projectId === project.id && !['verified', 'closed'].includes(item.status));
          const contracts = data.contracts.filter(item => item.workspaceId === workspaceId && item.projectId === project.id);
          let state = 'not_started';
          if (latestRun?.status === 'running') state = 'running';
          else if (latestRun?.status === 'queued') state = 'queued';
          else if (latestRun?.status === 'failed' || latestRun?.execution?.verdict === 'failed') state = 'failed';
          else if (decision?.verdict === 'approve') state = 'approved';
          else if (decision?.verdict === 'hold') state = 'held';
          else if (latestRun?.execution?.verdict === 'passed') state = 'awaiting_approval';
          else if (latestRun) state = 'evidence_insufficient';
          return { id: project.id, name: project.name, branch: project.branch, url: project.url, state, updatedAt: latestRun?.completedAt || latestRun?.failedAt || latestRun?.createdAt || project.updatedAt, latestRun: latestRun ? { id: latestRun.id, requirement: latestRun.requirement, status: latestRun.status, verdict: latestRun.execution?.verdict || null, createdAt: latestRun.createdAt } : null, decision: decision ? { verdict: decision.verdict, owner: decision.owner, createdAt: decision.createdAt } : null, counts: { runs: runs.length, openIssues: openIssues.length, contracts: contracts.length, enabledContracts: contracts.filter(item => item.enabled).length } };
        }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const actionableStates = new Set(['failed', 'held', 'evidence_insufficient']);
        const archived = data.projects.filter(item => item.workspaceId === workspaceId && item.archivedAt).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)).map(project => ({ id: project.id, name: project.name, branch: project.branch, archivedAt: project.archivedAt, archivedByUserId: project.archivedByUserId, archiveReason: project.archiveReason, counts: { runs: data.runs.filter(item => item.workspaceId === workspaceId && item.projectId === project.id).length, contracts: data.contracts.filter(item => item.workspaceId === workspaceId && item.projectId === project.id).length } }));
        return json(res, 200, { summary: { projects: items.length, actionable: items.filter(item => actionableStates.has(item.state) || item.counts.openIssues > 0).length, inProgress: items.filter(item => ['queued', 'running', 'awaiting_approval'].includes(item.state)).length, approved: items.filter(item => item.state === 'approved').length, archived: archived.length }, items, archived });
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        const data = await store.read();
        const includeArchived = url.searchParams.get('includeArchived') === 'true';
        const projects = data.projects.filter(item => item.workspaceId === workspaceId && (includeArchived || !item.archivedAt)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const storedProjectId = data.projectSelections.find(item => item.workspaceId === workspaceId && item.userId === currentUser.id)?.projectId;
        const activeProjects = projects.filter(item => !item.archivedAt); const selectedProjectId = activeProjects.some(item => item.id === storedProjectId) ? storedProjectId : activeProjects[0]?.id;
        return json(res, 200, projects.map(item => ({ ...item, selected: item.id === selectedProjectId })));
      }
      if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'projects' && segments[2] && segments[3] === 'archive') {
        requireRole(['owner']); const input = await body(req);
        const result = await store.update(data => {
          const project = data.projects.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
          const archived = input.archived !== false; const now = new Date().toISOString();
          if (archived) {
            if (project.archivedAt) return project;
            const activeRuns = data.runs.filter(item => item.workspaceId === workspaceId && item.projectId === project.id && ['queued', 'running'].includes(item.status));
            if (activeRuns.length) throw Object.assign(new Error(`项目还有 ${activeRuns.length} 个等待或执行中的任务，请先处理后再归档`), { status: 409 });
            project.archivedAt = now; project.archivedByUserId = currentUser.id; project.archiveReason = required(input.reason, '归档原因', 1000);
            const fallback = data.projects.filter(item => item.workspaceId === workspaceId && item.id !== project.id && !item.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            for (const selection of data.projectSelections.filter(item => item.workspaceId === workspaceId && item.projectId === project.id)) { if (fallback) { selection.projectId = fallback.id; selection.updatedAt = now; } }
            if (!fallback) data.projectSelections = data.projectSelections.filter(item => item.workspaceId !== workspaceId || item.projectId !== project.id);
          } else {
            if (!project.archivedAt) return project;
            delete project.archivedAt; delete project.archivedByUserId; delete project.archiveReason;
          }
          project.updatedAt = now;
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: archived ? 'project.archived' : 'project.restored', entityType: 'project', entityId: project.id, details: archived ? { reason: project.archiveReason } : {}, at: now });
          return project;
        });
        return json(res, 200, result);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'projects' && segments[2] && segments[3] === 'select') {
        const selected = await store.update(data => {
          const project = data.projects.find(item => item.id === segments[2] && item.workspaceId === workspaceId && !item.archivedAt); if (!project) throw Object.assign(new Error('项目不存在或已归档'), { status: 404 });
          let preference = data.projectSelections.find(item => item.workspaceId === workspaceId && item.userId === currentUser.id); const now = new Date().toISOString();
          if (!preference) { preference = { id: createId('psl'), workspaceId, userId: currentUser.id, projectId: project.id, updatedAt: now }; data.projectSelections.push(preference); }
          else { preference.projectId = project.id; preference.updatedAt = now; }
          return project;
        });
        return json(res, 200, selected);
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(req); const repoPath = required(input.repo, '项目目录', 4096); const targetUrl = validateTargetUrl(required(input.url, '测试网址', 2048), allowedTargetOrigins).href;
        const project = await store.update(data => {
          const now = new Date().toISOString();
          const existing = data.projects.find(item => item.id === input.id && item.workspaceId === workspaceId);
          if (existing?.archivedAt) throw Object.assign(new Error('已归档项目不能修改，请先恢复'), { status: 409 });
          const branch = required(input.branch || 'main', '代码分支', 255); const githubRepo = normalizeGitHubRepository(input.githubRepo ?? existing?.githubRepo, { optional: true });
          const repositoryStatus = existing?.repositoryStatus?.repository === githubRepo && existing.repositoryStatus.branch === branch ? existing.repositoryStatus : null;
          const value = { id: existing?.id || createId('prj'), workspaceId, name: required(input.name || '未命名项目', '项目名称'), repo: repoPath, url: targetUrl, branch, handoffMode: input.handoffMode || 'file', githubRepo, repositoryStatus, updatedAt: now, createdAt: existing?.createdAt || now };
          existing ? Object.assign(existing, value) : data.projects.push(value);
          let preference = data.projectSelections.find(item => item.workspaceId === workspaceId && item.userId === currentUser.id); if (!preference) data.projectSelections.push({ id: createId('psl'), workspaceId, userId: currentUser.id, projectId: value.id, updatedAt: now }); else { preference.projectId = value.id; preference.updatedAt = now; }
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: existing ? 'project.updated' : 'project.created', entityType: 'project', entityId: value.id, details: { branch: value.branch, handoffMode: value.handoffMode }, at: now });
          return value;
        });
        return json(res, 201, project);
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'projects' && segments[2] && segments[3] === 'repository') {
        const project = authData.projects.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!project) return json(res, 404, { error: '项目不存在' });
        return json(res, 200, { configured: Boolean(project.githubRepo), repository: project.githubRepo || null, branch: project.branch, status: project.repositoryStatus || null });
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'projects' && segments[2] && segments[3] === 'repository' && segments[4] === 'sync') {
        requireRole(['owner', 'approver']);
        const project = authData.projects.find(item => item.id === segments[2] && item.workspaceId === workspaceId && !item.archivedAt);
        if (!project) return json(res, 404, { error: '项目不存在或已归档' });
        if (!project.githubRepo) return json(res, 409, { error: '请先配置 GitHub 仓库' });
        const saved = await syncRepositoryProject({ projectId: project.id, actorUserId: currentUser.id, trigger: 'manual' });
        return json(res, 200, saved);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'preflight') {
        const data = await store.read();
        const project = data.projects.find(item => item.id === segments[2] && item.workspaceId === workspaceId && !item.archivedAt);
        if (!project) return json(res, 404, { error: '项目不存在' });
        const [repo, target, browserRuntime] = await Promise.all([checkRepository(project.repo), checkUrl(project.url, allowedTargetOrigins), checkBrowserAvailability()]);
        const workspaceSecrets = data.acceptanceSecrets.filter(item => item.workspaceId === workspaceId); const availableSecrets = new Set(workspaceSecrets.filter(item => acceptanceSecretIsUsable(item)).map(item => item.name)); const requiredSecrets = [...new Set(data.contracts.filter(item => item.workspaceId === workspaceId && item.projectId === project.id && item.enabled).flatMap(item => (item.steps || []).map(step => step.secretRef).filter(Boolean)))]; const missingSecretRefs = requiredSecrets.filter(name => !availableSecrets.has(name)); const expiredSecretRefs = requiredSecrets.filter(name => workspaceSecrets.some(item => item.name === name && !acceptanceSecretIsUsable(item)));
        const checks = { repo, url: target, browser: target.status === 'ready' ? browserRuntime : { status: 'blocked', detail: '测试网址不可用' }, credentials: missingSecretRefs.length ? { status: 'failed', detail: expiredSecretRefs.length ? `有 ${expiredSecretRefs.length} 个验收凭据已过期：${expiredSecretRefs.join('、')}` : `缺少 ${missingSecretRefs.length} 个验收凭据：${missingSecretRefs.join('、')}`, missingSecretRefs, expiredSecretRefs } : { status: 'ready', detail: requiredSecrets.length ? `${requiredSecrets.length} 个验收凭据均在有效期内` : '当前启用标准不需要验收凭据', missingSecretRefs: [], expiredSecretRefs: [] }, handoff: project.handoffMode === 'agent' ? { status: 'warning', detail: '编码 AI 连接器尚未配置' } : { status: 'ready', detail: project.handoffMode === 'file' ? '保存为本地返工单' : '复制任务文本' } };
        return json(res, 200, { projectId: project.id, checkedAt: new Date().toISOString(), checks });
      }
      if (req.method === 'GET' && url.pathname === '/api/contracts/export') {
        const data = await store.read(); const projectId = url.searchParams.get('projectId');
        const project = data.projects.find(item => item.id === projectId && item.workspaceId === workspaceId);
        if (!project) return json(res, 404, { error: '项目不存在' });
        const contracts = data.contracts.filter(item => item.workspaceId === workspaceId && item.projectId === project.id).map(({ code, title, description, category, severity, steps, enabled }) => ({ code, title, description, category, severity, steps, enabled }));
        return json(res, 200, { schema: 'shipwitness.contract-pack.v1', name: `${project.name} 验收标准`, sourceProject: { id: project.id, name: project.name }, exportedAt: new Date().toISOString(), contracts });
      }
      if (req.method === 'POST' && (url.pathname === '/api/contracts/import/preview' || url.pathname === '/api/contracts/import')) {
        const input = await body(req); const data = await store.read();
        const target = data.projects.find(item => item.id === input.projectId && item.workspaceId === workspaceId && !item.archivedAt);
        if (!target) return json(res, 404, { error: '目标项目不存在' });
        let rawContracts = input.contracts;
        if (input.sourceProjectId) {
          const source = data.projects.find(item => item.id === input.sourceProjectId && item.workspaceId === workspaceId);
          if (!source) return json(res, 404, { error: '来源项目不存在' });
          rawContracts = data.contracts.filter(item => item.workspaceId === workspaceId && item.projectId === source.id);
        }
        const definitions = normalizeContractPack(rawContracts);
        const existingCodes = new Set(data.contracts.filter(item => item.workspaceId === workspaceId && item.projectId === target.id).map(item => item.code));
        const preview = { total: definitions.length, create: definitions.filter(item => !existingCodes.has(item.code)).length, conflicts: definitions.filter(item => existingCodes.has(item.code)).map(item => item.code) };
        if (url.pathname.endsWith('/preview')) return json(res, 200, preview);
        const conflictMode = input.conflictMode || 'skip';
        if (!['skip', 'replace'].includes(conflictMode)) return json(res, 400, { error: '冲突处理方式无效' });
        const result = await store.update(current => {
          const now = new Date().toISOString(); let created = 0; let replaced = 0; let skipped = 0;
          for (const definition of definitions) {
            const existing = current.contracts.find(item => item.workspaceId === workspaceId && item.projectId === target.id && item.code === definition.code);
            if (existing && conflictMode === 'skip') { skipped += 1; continue; }
            if (existing) { Object.assign(existing, definition, { version: existing.version + 1, updatedAt: now }); replaced += 1; }
            else { current.contracts.unshift({ ...definition, id: createId('ctr'), workspaceId, projectId: target.id, version: 1, createdAt: now, updatedAt: now }); created += 1; }
          }
          appendAudit(current, { workspaceId, actorUserId: currentUser.id, action: 'contract_pack.imported', entityType: 'project', entityId: target.id, details: { total: definitions.length, created, replaced, skipped, conflictMode }, at: now });
          return { ...preview, created, replaced, skipped, conflictMode };
        });
        return json(res, 201, result);
      }
      if (req.method === 'PATCH' && url.pathname === '/api/contracts/bulk') {
        const input = await body(req); if (typeof input.enabled !== 'boolean') return json(res, 400, { error: 'enabled 必须是布尔值' });
        const changed = await store.update(data => {
          if (!data.projects.some(item => item.id === input.projectId && item.workspaceId === workspaceId && !item.archivedAt)) throw Object.assign(new Error('项目不存在或已归档'), { status: 404 });
          const ids = Array.isArray(input.ids) ? new Set(input.ids.map(String)) : null; const now = new Date().toISOString(); let count = 0;
          for (const contract of data.contracts.filter(item => item.workspaceId === workspaceId && item.projectId === input.projectId && (!ids || ids.has(item.id)))) { if (contract.enabled === input.enabled) continue; contract.enabled = input.enabled; contract.version += 1; contract.updatedAt = now; count += 1; }
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'contract.bulk_updated', entityType: 'project', entityId: input.projectId, details: { enabled: input.enabled, count }, at: now }); return { count, enabled: input.enabled };
        });
        return json(res, 200, changed);
      }
      if (req.method === 'GET' && url.pathname === '/api/contracts') {
        const data = await store.read();
        const contracts = (data.contracts || []).filter(item => item.workspaceId === workspaceId && (!url.searchParams.get('projectId') || item.projectId === url.searchParams.get('projectId')));
        contracts.sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt.localeCompare(a.updatedAt));
        const availableSecrets = new Set(data.acceptanceSecrets.filter(item => item.workspaceId === workspaceId && acceptanceSecretIsUsable(item)).map(item => item.name));
        return json(res, 200, contracts.map(item => ({ ...item, missingSecretRefs: [...new Set((item.steps || []).map(step => step.secretRef).filter(name => name && !availableSecrets.has(name)))] })));
      }
      if (req.method === 'POST' && url.pathname === '/api/contracts') {
        const input = await body(req);
        const contract = await store.update(data => {
          data.contracts ||= [];
          if (!data.projects.some(item => item.id === input.projectId && item.workspaceId === workspaceId && !item.archivedAt)) throw Object.assign(new Error('项目不存在或已归档'), { status: 404 });
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
          if (data.projects.find(item => item.id === current.projectId)?.archivedAt) throw Object.assign(new Error('已归档项目不能修改标准，请先恢复'), { status: 409 });
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
        const idempotencyKey = String(req.headers['idempotency-key'] || '');
        if (versionedApi && apiKey && !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) return json(res, 400, { error: '机器调用创建任务时必须提供 8-200 位 Idempotency-Key' });
        const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const created = await store.update(data => {
          if (versionedApi && apiKey) {
            const existing = data.idempotencyRecords.find(item => item.workspaceId === workspaceId && item.apiKeyId === apiKey.id && item.operation === 'run.create' && item.key === idempotencyKey);
            if (existing) {
              if (existing.requestHash !== requestHash) throw Object.assign(new Error('同一个 Idempotency-Key 不能用于不同请求'), { status: 409 });
              const run = data.runs.find(item => item.id === existing.entityId && item.workspaceId === workspaceId);
              if (!run) throw Object.assign(new Error('幂等记录关联的验收任务不存在'), { status: 409 });
              return { run, replayed: true };
            }
          }
          const project = data.projects.find(item => item.id === input.projectId && item.workspaceId === workspaceId && !item.archivedAt);
          if (!project) throw Object.assign(new Error('项目不存在或已归档'), { status: 404 });
          data.contracts ||= [];
          const supplied = Array.isArray(input.criteria) ? input.criteria : [];
          const criteria = supplied.length ? supplied.map(item => { const { sourceFeedbackId: ignored, ...safe } = item; return { ...safe, steps: normalizeSteps(item.steps) }; }) : data.contracts.filter(item => item.workspaceId === workspaceId && item.projectId === input.projectId && item.enabled).map(item => ({ contractId: item.id, code: item.code, title: item.title, description: item.description, category: item.category, severity: item.severity, steps: normalizeSteps(item.steps), version: item.version, ...(item.sourceFeedbackId ? { sourceFeedbackId: item.sourceFeedbackId } : {}) }));
          const availableSecrets = new Set(data.acceptanceSecrets.filter(item => item.workspaceId === workspaceId && acceptanceSecretIsUsable(item)).map(item => item.name)); const missingSecretRefs = [...new Set(criteria.flatMap(item => (item.steps || []).map(step => step.secretRef).filter(name => name && !availableSecrets.has(name))))];
          if (missingSecretRefs.length) throw Object.assign(new Error(`验收任务缺少凭据：${missingSecretRefs.join('、')}；请管理员先在凭据保险箱中配置`), { status: 409 });
          const value = { id: createId('run'), workspaceId, projectId: input.projectId, requirement: required(input.requirement, '原始需求'), criteria, repositorySnapshot: project.repositoryStatus ? structuredClone(project.repositoryStatus) : null, status: 'queued', attemptNumber: 1, createdAt: new Date().toISOString() };
          data.runs.unshift(value);
          if (versionedApi && apiKey) data.idempotencyRecords.unshift({ id: createId('idem'), workspaceId, apiKeyId: apiKey.id, operation: 'run.create', key: idempotencyKey, requestHash, entityId: value.id, createdAt: value.createdAt });
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'run.created', entityType: 'run', entityId: value.id, details: { criteriaCount: criteria.length, source: versionedApi ? 'extension_api_v1' : 'web' }, at: value.createdAt }); return { run: value, replayed: false };
        });
        return json(res, created.replayed ? 200 : 201, created.run, created.replayed ? { 'idempotent-replayed': 'true' } : {});
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'runs' && segments[2] && segments[3] === 'retry') {
        const retried = await store.update(data => {
          const source = data.runs.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!source) throw Object.assign(new Error('验收记录不存在'), { status: 404 });
          if (data.projects.find(item => item.id === source.projectId)?.archivedAt) throw Object.assign(new Error('已归档项目不能创建复验，请先恢复'), { status: 409 });
          if (!['completed', 'failed'].includes(source.status)) throw Object.assign(new Error('只有已完成或执行失败的任务才能创建重试'), { status: 409 });
          const now = new Date().toISOString(); const rootRunId = source.rootRunId || source.retryOfRunId || source.id; const project = data.projects.find(item => item.id === source.projectId);
          const run = { id: createId('run'), workspaceId, projectId: source.projectId, requirement: source.requirement, criteria: structuredClone(source.criteria), repositorySnapshot: project?.repositoryStatus ? structuredClone(project.repositoryStatus) : null, status: 'queued', attemptNumber: Number(source.attemptNumber || 1) + 1, retryOfRunId: source.id, rootRunId, createdByUserId: currentUser.id, createdAt: now };
          data.runs.unshift(run); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'run.retry_created', entityType: 'run', entityId: run.id, details: { sourceRunId: source.id, rootRunId, attemptNumber: run.attemptNumber }, at: now }); return run;
        });
        return json(res, 201, retried);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'runs' && segments[2] && segments[3] === 'execute') {
        const snapshot = await store.read();
        const run = snapshot.runs.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!run) return json(res, 404, { error: '验收记录不存在' });
        const project = snapshot.projects.find(item => item.id === run.projectId && item.workspaceId === workspaceId);
        if (!project) return json(res, 409, { error: '任务关联的项目不存在' });
        validateTargetUrl(project.url, allowedTargetOrigins);
        await store.update(data => {
          const current = data.runs.find(item => item.id === run.id); const stale = current.status === 'running' && new Date(current.startedAt || 0) <= new Date(Date.now() - 15 * 60_000);
          if (current.status === 'running' && !stale) throw Object.assign(new Error('任务正在执行'), { status: 409 });
          if (!stale && current.status !== 'queued') throw Object.assign(new Error('历史任务不可覆写，请创建重试任务'), { status: 409 });
          current.status = 'running'; current.startedAt = new Date().toISOString(); current.startedByUserId = currentUser.id;
          if (stale) { current.recoveryCount = Number(current.recoveryCount || 0) + 1; current.recoveredAt = current.startedAt; }
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: stale ? 'run.recovered' : 'run.started', entityType: 'run', entityId: current.id, details: { attemptNumber: current.attemptNumber || 1, recoveryCount: current.recoveryCount || 0 }, at: current.startedAt });
        });
        try {
          const hasBrowserSteps = run.criteria.some(item => Array.isArray(item.steps) && item.steps.length);
          const secretRefs = new Set(run.criteria.flatMap(item => item.steps || []).map(step => step.secretRef).filter(Boolean)); const executionSecrets = {};
          for (const item of authData.acceptanceSecrets.filter(value => value.workspaceId === workspaceId && secretRefs.has(value.name) && acceptanceSecretIsUsable(value))) executionSecrets[item.name] = decryptSecret(item.encryptedValue, signingSecret);
          const execution = hasBrowserSteps ? await browserRunExecutor({ project, run, artifactsDir, allowedOrigins: allowedTargetOrigins, secrets: executionSecrets }) : await basicRunExecutor(project, run, allowedTargetOrigins);
          const completed = await store.update(data => {
            const current = data.runs.find(item => item.id === run.id);
            current.status = 'completed'; current.execution = execution; current.completedAt = new Date().toISOString(); current.failure = null;
            for (const issueId of current.issueIds || []) {
              const issue = data.issues.find(item => item.id === issueId);
              if (!issue) continue;
              issue.status = execution.verdict === 'passed' ? 'verified' : 'handed_off';
              issue.updatedAt = current.completedAt;
              issue.timeline ||= [];
              issue.timeline.push({ status: issue.status, at: current.completedAt, note: execution.verdict === 'passed' ? '定向复验通过' : `定向复验未通过：${execution.summary}` });
            }
            current.criteria.forEach((criterion, index) => {
              if (!criterion.sourceFeedbackId || execution.criteriaResults?.[index]?.result !== 'passed') return;
              const feedback = data.pilotFeedback.find(item => item.id === criterion.sourceFeedbackId && item.workspaceId === workspaceId && item.linkedContractId === criterion.contractId && item.status === 'planned');
              if (!feedback) return;
              const result = execution.criteriaResults[index]; feedback.status = 'resolved'; feedback.updatedAt = current.completedAt; feedback.verification = { runId: current.id, contractId: criterion.contractId, contractVersion: criterion.version, criterionResultId: result.id, executor: execution.executor, verifiedAt: current.completedAt }; feedback.timeline ||= []; feedback.timeline.push({ status: 'resolved', at: current.completedAt, actorUserId: currentUser.id, note: `验收任务 ${current.id} 的来源标准已通过真实断言` });
              appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'feedback.verified_by_run', entityType: 'pilot_feedback', entityId: feedback.id, details: { runId: current.id, contractId: criterion.contractId, contractVersion: criterion.version, criterionResultId: result.id }, at: current.completedAt });
            });
            appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'run.completed', entityType: 'run', entityId: current.id, details: { verdict: execution.verdict, executor: execution.executor, attemptNumber: current.attemptNumber || 1, recoveryCount: current.recoveryCount || 0 }, at: current.completedAt });
            if (['passed', 'failed'].includes(execution.verdict)) {
              const projectName = data.projects.find(item => item.id === current.projectId)?.name || '未命名项目'; const runUrl = publicUrl ? `${publicUrl}/?run=${encodeURIComponent(current.id)}` : null;
              const recipientIds = new Set(data.memberships.filter(item => item.workspaceId === workspaceId && ['owner', 'approver'].includes(item.role)).map(item => item.userId));
              for (const user of data.users.filter(item => recipientIds.has(item.id))) {
                const passed = execution.verdict === 'passed'; const subject = passed ? `${projectName} 等待发布审批` : `${projectName} 验收失败，需要处理`;
                const summary = passed ? '全部验收标准已有通过证据，请由负责人确认是否发布。' : '至少一条验收路径未通过，请查看证据并创建返工单。';
                queueEmail(data, { workspaceId, to: user.email, kind: passed ? 'release_approval' : 'run_failed', entityId: current.id, subject, text: `${summary}${runUrl ? `\n打开 ShipWitness：${runUrl}` : ''}`, html: `<p>${htmlEscape(summary)}</p>${runUrl ? `<p><a href="${htmlEscape(runUrl)}">打开验收任务</a></p>` : ''}<p>任务：${htmlEscape(current.id)}</p>` });
              }
            }
            return current;
          });
          return json(res, 200, completed);
        } catch (error) {
          await store.update(data => { const current = data.runs.find(item => item.id === run.id); current.status = 'failed'; current.failure = '执行器发生内部错误'; current.failedAt = new Date().toISOString(); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'run.failed', entityType: 'run', entityId: current.id, details: { failure: current.failure, attemptNumber: current.attemptNumber || 1 }, at: current.failedAt }); });
          throw error;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const input = await body(req); const kind = input.kind || 'issue'; const severity = input.severity || 'medium';
        if (!['issue', 'suggestion', 'usability'].includes(kind)) return json(res, 400, { error: '反馈类型无效' });
        if (!['low', 'medium', 'high', 'blocker'].includes(severity)) return json(res, 400, { error: '反馈级别无效' });
        const projectId = String(input.projectId || '').trim() || null;
        if (projectId && !authData.projects.some(item => item.id === projectId && item.workspaceId === workspaceId && !item.archivedAt)) return json(res, 400, { error: '关联项目不存在或已归档' });
        const now = new Date().toISOString();
        const feedback = await store.update(data => {
          const value = { id: createId('fb'), workspaceId, projectId, reporterUserId: currentUser.id, kind, severity, title: required(input.title, '反馈标题', 200), description: required(input.description, '反馈说明', 5000), status: 'new', createdAt: now, updatedAt: now, timeline: [{ status: 'new', at: now, actorUserId: currentUser.id, note: '提交试点反馈' }] };
          data.pilotFeedback.unshift(value); appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'feedback.created', entityType: 'pilot_feedback', entityId: value.id, details: { projectId, kind, severity }, at: now }); return value;
        });
        return json(res, 201, feedback);
      }
      if (req.method === 'GET' && url.pathname === '/api/feedback') {
        const status = url.searchParams.get('status'); const projectId = url.searchParams.get('projectId');
        if (status && !['new', 'triaged', 'planned', 'resolved', 'declined'].includes(status)) return json(res, 400, { error: '反馈状态无效' });
        const data = await store.read();
        const items = data.pilotFeedback.filter(item => item.workspaceId === workspaceId && (!status || item.status === status) && (!projectId || item.projectId === projectId)).map(item => ({ ...item, reporter: publicUser(data.users.find(user => user.id === item.reporterUserId)), project: item.projectId ? data.projects.find(project => project.id === item.projectId && project.workspaceId === workspaceId) ? { id: item.projectId, name: data.projects.find(project => project.id === item.projectId).name } : null : null }));
        return json(res, 200, items);
      }
      if (req.method === 'GET' && url.pathname === '/api/feedback/export') {
        requireRole(['owner', 'approver']); const data = await store.read(); const now = new Date().toISOString();
        const items = data.pilotFeedback.filter(item => item.workspaceId === workspaceId);
        const document = { schema: 'shipwitness.pilot-feedback.v1', workspace: { id: currentWorkspace.id, name: currentWorkspace.name }, exportedAt: now, items };
        await store.update(current => appendAudit(current, { workspaceId, actorUserId: currentUser.id, action: 'feedback.exported', entityType: 'workspace', entityId: workspaceId, details: { count: items.length }, at: now }));
        return json(res, 200, document, { 'content-disposition': `attachment; filename="shipwitness-feedback-${now.slice(0, 10)}.json"` });
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'feedback' && segments[2] && segments[3] === 'promote' && segments.length === 4) {
        requireRole(['owner', 'approver']); const input = await body(req); const now = new Date().toISOString();
        const result = await store.update(data => {
          const feedback = data.pilotFeedback.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!feedback) throw Object.assign(new Error('试点反馈不存在'), { status: 404 });
          if (!feedback.projectId) throw Object.assign(new Error('工作区通用反馈必须先关联项目才能转为验收标准'), { status: 409 });
          if (feedback.linkedContractId) throw Object.assign(new Error('该反馈已经转为验收标准'), { status: 409 });
          if (['resolved', 'declined'].includes(feedback.status)) throw Object.assign(new Error('已结束的反馈不能再转为验收标准'), { status: 409 });
          const project = data.projects.find(item => item.id === feedback.projectId && item.workspaceId === workspaceId && !item.archivedAt);
          if (!project) throw Object.assign(new Error('关联项目不存在或已归档'), { status: 409 });
          const code = `FB-${feedback.id.slice(-6).toUpperCase()}`;
          const contract = { id: createId('ctr'), workspaceId, projectId: project.id, code, title: required(input.title || `反馈验收：${feedback.title}`, '标准名称', 500), description: required(input.expectedResult, '正确结果', 5000), category: feedback.kind === 'usability' ? '可用性' : feedback.kind === 'suggestion' ? '业务流程' : '缺陷回归', severity: feedback.severity === 'blocker' ? 'blocker' : feedback.severity === 'high' ? 'major' : 'minor', steps: [], enabled: false, version: 1, sourceFeedbackId: feedback.id, createdAt: now, updatedAt: now };
          data.contracts.unshift(contract); const from = feedback.status; feedback.status = 'planned'; feedback.linkedContractId = contract.id; feedback.updatedAt = now; feedback.timeline ||= []; feedback.timeline.push({ status: 'planned', at: now, actorUserId: currentUser.id, note: `已生成验收标准草稿 ${code}` });
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'feedback.promoted', entityType: 'pilot_feedback', entityId: feedback.id, details: { contractId: contract.id, projectId: project.id, from, to: feedback.status }, at: now });
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'contract.created', entityType: 'contract', entityId: contract.id, details: { projectId: project.id, code, sourceFeedbackId: feedback.id, enabled: false }, at: now });
          return { feedback, contract };
        });
        return json(res, 201, result);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'feedback' && segments[2] && segments[3] === 'reopen' && segments.length === 4) {
        requireRole(['owner', 'approver']); const input = await body(req); const reason = required(input.reason, '重新打开原因', 1000); const now = new Date().toISOString();
        const feedback = await store.update(data => {
          const current = data.pilotFeedback.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!current) throw Object.assign(new Error('试点反馈不存在'), { status: 404 });
          if (!['resolved', 'declined'].includes(current.status)) throw Object.assign(new Error('只有已结束的反馈才能重新打开'), { status: 409 });
          const previousStatus = current.status; const previousVerification = current.verification ? structuredClone(current.verification) : null;
          if (previousVerification) { current.verificationHistory ||= []; current.verificationHistory.push(previousVerification); delete current.verification; }
          current.status = current.linkedContractId ? 'planned' : 'triaged'; current.updatedAt = now; current.timeline ||= []; current.timeline.push({ status: current.status, at: now, actorUserId: currentUser.id, note: `重新打开：${reason}` });
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'feedback.reopened', entityType: 'pilot_feedback', entityId: current.id, details: { from: previousStatus, to: current.status, reason, previousVerificationRunId: previousVerification?.runId || null }, at: now }); return current;
        });
        return json(res, 200, feedback);
      }
      if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'feedback' && segments[2] && segments.length === 3) {
        requireRole(['owner', 'approver']); const input = await body(req); const allowed = ['new', 'triaged', 'planned', 'resolved', 'declined'];
        if (!allowed.includes(input.status)) return json(res, 400, { error: '反馈状态无效' });
        const note = String(input.note || '').trim().slice(0, 1000);
        if (['resolved', 'declined'].includes(input.status) && !note) return json(res, 400, { error: '结束反馈前必须填写处理结论' });
        const feedback = await store.update(data => {
          const current = data.pilotFeedback.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
          if (!current) throw Object.assign(new Error('试点反馈不存在'), { status: 404 });
          if (['resolved', 'declined'].includes(current.status) && current.status !== input.status) throw Object.assign(new Error('已结束的反馈必须通过“重新打开”保留处理历史'), { status: 409 });
          if (current.status === input.status) return current;
          const from = current.status; current.status = input.status; current.updatedAt = new Date().toISOString(); current.timeline ||= []; current.timeline.push({ status: input.status, at: current.updatedAt, actorUserId: currentUser.id, note });
          appendAudit(data, { workspaceId, actorUserId: currentUser.id, action: 'feedback.status_changed', entityType: 'pilot_feedback', entityId: current.id, details: { from, to: input.status, note }, at: current.updatedAt }); return current;
        });
        return json(res, 200, feedback);
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
          const project = data.projects.find(item => item.id === source.projectId);
          const run = { id: createId('run'), workspaceId, projectId: source.projectId, requirement: `复验返工单 ${issue.id}：${issue.title}`, criteria, repositorySnapshot: project?.repositoryStatus ? structuredClone(project.repositoryStatus) : null, status: 'queued', attemptNumber: 1, parentRunId: source.id, issueIds: [issue.id], createdAt: now };
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
        const extension = extname(file); const cacheControl = ['.html', '.js', '.css'].includes(extension) ? 'no-cache' : 'public, max-age=300';
        res.writeHead(200, { ...securityHeaders, 'content-type': mime[extension] || 'application/octet-stream', 'cache-control': cacheControl });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch { json(res, 404, { error: '文件不存在' }); }
    } catch (error) {
      json(res, error.status || 500, { error: error.status ? error.message : '服务器内部错误' });
    }
  });
  server.processWebhookDeliveries = processWebhookDeliveries;
  server.processEmailDeliveries = processEmailDeliveries;
  server.closeStore = async () => { clearInterval(webhookTimer); clearInterval(emailTimer); await store.close?.(); };
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
