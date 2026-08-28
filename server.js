import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { JsonStore, createId } from './lib/store.js';
import { PostgresStore } from './lib/postgres-store.js';
import { checkBrowserAvailability, executeBrowserRun, normalizeSteps } from './lib/browser-executor.js';
import { clearSessionCookie, createSessionToken, hashPassword, readSessionToken, sessionCookie, verifyPassword } from './lib/auth.js';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'outputs/shipwitness-prototype');
const defaultStore = process.env.SHIPWITNESS_STORE_FILE || join(root, 'data/store.json');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const serviceVersion = '0.4.0-dev.2';
const securityHeaders = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
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

const required = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${field}不能为空`), { status: 400 });
  return value.trim();
};

const normalizedEmail = value => {
  const email = required(value, '邮箱').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('邮箱格式无效'), { status: 400 });
  return email;
};

const publicUser = user => ({ id: user.id, email: user.email, name: user.name, createdAt: user.createdAt });
const sessionTokenHash = token => createHash('sha256').update(String(token || '')).digest('hex');

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

async function checkUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    const response = await fetch(parsed, { signal: AbortSignal.timeout(3500), redirect: 'manual' });
    return response.status < 500 ? { status: 'ready', detail: `HTTP ${response.status}` } : { status: 'failed', detail: `HTTP ${response.status}` };
  } catch { return { status: 'failed', detail: '网址当前无法访问' }; }
}

async function inspectTarget(url) {
  const started = Date.now();
  try {
    const response = await fetch(new URL(url), { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    const contentType = response.headers.get('content-type') || 'unknown';
    const text = (await response.text()).slice(0, 250_000);
    const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null;
    return { status: response.status < 500 ? 'ready' : 'failed', httpStatus: response.status, finalUrl: response.url, contentType, title, durationMs: Date.now() - started, bodyBytesInspected: Buffer.byteLength(text), contentSha256: createHash('sha256').update(text).digest('hex') };
  } catch (error) {
    return { status: 'failed', error: error.name === 'TimeoutError' ? '请求超时' : '目标不可访问', durationMs: Date.now() - started };
  }
}

async function executeRun(project, run) {
  const [repository, target] = await Promise.all([checkRepository(project.repo), inspectTarget(project.url)]);
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

export function createApp({ storeFile = defaultStore, databaseUrl = process.env.DATABASE_URL, store: providedStore } = {}) {
  const store = providedStore || (databaseUrl ? new PostgresStore(databaseUrl) : new JsonStore(storeFile));
  const artifactsDir = process.env.SHIPWITNESS_ARTIFACTS_DIR || join(dirname(storeFile), 'evidence');
  const loginAttempts = new Map();
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
        await store.update(current => { current.sessions = current.sessions.filter(item => new Date(item.expiresAt) > new Date()); current.sessions.push({ id: createId('ses'), tokenHash: sessionTokenHash(token), userId: user.id, workspaceId: membership.workspaceId, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), createdAt: now }); });
        const workspace = data.workspaces.find(item => item.id === membership.workspaceId);
        return json(res, 200, { user: publicUser(user), workspace, role: membership.role }, { 'set-cookie': sessionCookie(token, { secure: secureCookie }) });
      }

      const authData = await store.read();
      const token = readSessionToken(req.headers.cookie);
      const tokenHash = sessionTokenHash(token);
      const session = authData.sessions.find(item => item.tokenHash === tokenHash && new Date(item.expiresAt) > new Date());
      const currentUser = session && authData.users.find(item => item.id === session.userId);
      const currentWorkspace = session && authData.workspaces.find(item => item.id === session.workspaceId);
      const membership = session && authData.memberships.find(item => item.userId === session.userId && item.workspaceId === session.workspaceId);
      if (url.pathname.startsWith('/api/') && !session) return json(res, 401, { error: '请先登录' });
      if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { user: publicUser(currentUser), workspace: currentWorkspace, role: membership?.role });
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        await store.update(data => { data.sessions = data.sessions.filter(item => item.tokenHash !== tokenHash); });
        return json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie(secureCookie) });
      }

      const workspaceId = session?.workspaceId;
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
          const active = data.sessions.find(item => item.tokenHash === tokenHash); active.workspaceId = value.id;
          return value;
        });
        return json(res, 201, workspace);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'workspaces' && segments[2] && segments[3] === 'select') {
        const targetMembership = authData.memberships.find(item => item.userId === currentUser.id && item.workspaceId === segments[2]);
        if (!targetMembership) return json(res, 404, { error: '工作区不存在' });
        await store.update(data => { data.sessions.find(item => item.tokenHash === tokenHash).workspaceId = targetMembership.workspaceId; });
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
          const item = { id: createId('mem'), workspaceId, userId: user.id, role, createdAt: now }; data.memberships.push(item); return { ...publicUser(user), role, membershipId: item.id };
        });
        return json(res, 201, member);
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, (await store.read()).projects.filter(item => item.workspaceId === workspaceId));
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(req);
        const project = await store.update(data => {
          const now = new Date().toISOString();
          const existing = data.projects.find(item => item.id === input.id && item.workspaceId === workspaceId);
          const value = { id: existing?.id || createId('prj'), workspaceId, name: required(input.name || '未命名项目', '项目名称'), repo: required(input.repo, '项目目录'), url: required(input.url, '测试网址'), branch: required(input.branch || 'main', '代码分支'), handoffMode: input.handoffMode || 'file', updatedAt: now, createdAt: existing?.createdAt || now };
          existing ? Object.assign(existing, value) : data.projects.push(value);
          return value;
        });
        return json(res, 201, project);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'preflight') {
        const data = await store.read();
        const project = data.projects.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!project) return json(res, 404, { error: '项目不存在' });
        const [repo, target, browserRuntime] = await Promise.all([checkRepository(project.repo), checkUrl(project.url), checkBrowserAvailability()]);
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
          data.contracts.unshift(value);
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
          data.runs.unshift(value); return value;
        });
        return json(res, 201, run);
      }
      if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'runs' && segments[2] && segments[3] === 'execute') {
        const snapshot = await store.read();
        const run = snapshot.runs.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!run) return json(res, 404, { error: '验收记录不存在' });
        if (run.status === 'running') return json(res, 409, { error: '任务正在执行' });
        const project = snapshot.projects.find(item => item.id === run.projectId && item.workspaceId === workspaceId);
        if (!project) return json(res, 409, { error: '任务关联的项目不存在' });
        await store.update(data => { const current = data.runs.find(item => item.id === run.id); current.status = 'running'; current.startedAt = new Date().toISOString(); });
        try {
          const hasBrowserSteps = run.criteria.some(item => Array.isArray(item.steps) && item.steps.length);
          const execution = hasBrowserSteps ? await executeBrowserRun({ project, run, artifactsDir }) : await executeRun(project, run);
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
            return current;
          });
          return json(res, 200, completed);
        } catch (error) {
          await store.update(data => { const current = data.runs.find(item => item.id === run.id); current.status = 'failed'; current.failure = '基础执行器发生内部错误'; });
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
          data.issues.unshift(value); return value;
        });
        return json(res, 201, issue);
      }
      if (req.method === 'GET' && url.pathname === '/api/issues') {
        const data = await store.read();
        const runId = url.searchParams.get('runId');
        const issues = data.issues.filter(item => item.workspaceId === workspaceId && (!runId || item.runId === runId || item.retestRunId === runId));
        return json(res, 200, issues);
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
          return { issue, run };
        });
        return json(res, 201, retest);
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions') {
        requireRole(['owner', 'approver']);
        const input = await body(req);
        const decision = await store.update(data => {
          const runId = required(input.runId, '验收记录');
          if (!data.runs.some(item => item.id === runId && item.workspaceId === workspaceId)) throw Object.assign(new Error('验收记录不存在'), { status: 404 });
          const value = { id: createId('decision'), workspaceId, runId, owner: required(input.owner, '负责人'), verdict: required(input.verdict, '决定'), note: input.note || '', createdAt: new Date().toISOString() }; data.decisions.unshift(value); return value;
        });
        return json(res, 201, decision);
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'dossiers' && segments[2]) {
        const data = await store.read();
        const run = data.runs.find(item => item.id === segments[2] && item.workspaceId === workspaceId);
        if (!run) return json(res, 404, { error: '验收记录不存在' });
        return json(res, 200, { schema: 'shipwitness.dossier.v1', workspaceId, run, issues: data.issues.filter(item => item.workspaceId === workspaceId && item.runId === run.id), decisions: data.decisions.filter(item => item.workspaceId === workspaceId && item.runId === run.id) });
      }
      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'evidence' && segments[2] && segments[3] && segments.length === 4) {
        if (!authData.runs.some(item => item.id === segments[2] && item.workspaceId === workspaceId)) return json(res, 404, { error: '验收记录不存在' });
        const evidenceRoot = resolve(artifactsDir, segments[2]);
        const file = resolve(evidenceRoot, normalize(segments[3]));
        if (!file.startsWith(`${evidenceRoot}/`) || extname(file) !== '.png') return json(res, 403, { error: '禁止访问' });
        try {
          const content = await readFile(file);
          res.writeHead(200, { ...securityHeaders, 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
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
  server.closeStore = () => store.close?.();
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
