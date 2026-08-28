const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...options.headers }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
};

let backendProjectId = null;
let backendRunId = null;
let backendContracts = [];
let backendProject = null;
let dashboardRun = null;
let dashboardCriterionIndex = 0;
let dashboardStage = 'claim';
let selectedBackendIssue = null;
let retentionPreviewState = null;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
const defaultContracts = [
  { code: 'AUTH-01', title: '权限隔离', description: '普通成员看不到管理入口，也不能通过网址直接进入后台。', category: '权限', severity: 'blocker' },
  { code: 'DATA-01', title: '资料保存', description: '出现“保存成功”后刷新页面，新资料仍然存在。', category: '数据', severity: 'blocker' },
  { code: 'DELETE-01', title: '删除客户', description: '管理员可以删除客户，且删除后的恢复方式必须符合产品决定。', category: '业务流程', severity: 'major' },
  { code: 'SESSION-01', title: '安全退出', description: '退出后访问受保护页面，必须返回登录页。', category: '安全', severity: 'blocker' }
];

document.body.insertAdjacentHTML('beforeend', `<div class="auth-gate" id="authGate" hidden><section class="auth-card"><div class="auth-brand"><span>S</span><div><b>ShipWitness</b><small>发布验收台</small></div></div><div class="auth-copy"><span id="authEyebrow">安全工作区</span><h1 id="authTitle">登录 ShipWitness</h1><p id="authDescription">验收证据、返工单和发布决定只对工作区成员可见。</p></div><form id="authForm"><label id="workspaceField" hidden><span>工作区名称</span><input id="authWorkspace" autocomplete="organization" value="我的工作区"></label><label id="nameField" hidden><span>你的姓名</span><input id="authName" autocomplete="name" value="管理员"></label><label id="emailField"><span>邮箱</span><input id="authEmail" type="email" autocomplete="username" required placeholder="owner@example.com"></label><label><span>密码</span><input id="authPassword" type="password" autocomplete="current-password" minlength="10" required placeholder="至少 10 个字符"></label><p class="auth-error" id="authError" hidden></p><button type="submit" id="authSubmit">登录</button></form><footer>本地私有部署 · 会话使用 HttpOnly 安全 Cookie</footer></section></div>`);
const accountSlot = document.createElement('div'); accountSlot.className = 'account-slot'; accountSlot.innerHTML = '<button id="accountBtn">—</button><button id="logoutBtn">退出</button>'; document.querySelector('.bar-actions').prepend(accountSlot);
document.body.insertAdjacentHTML('beforeend', `<aside class="account-panel" id="accountPanel" aria-hidden="true"><header><div><span>组织、权限与自动化</span><h2>工作区管理</h2></div><button id="closeAccount" aria-label="关闭">×</button></header><section class="workspace-section"><div class="section-title"><div><b>我的工作区</b><small>切换后只显示该工作区的数据</small></div></div><div id="workspaceList" class="workspace-list"></div><form id="workspaceForm" class="inline-create"><input id="newWorkspaceName" placeholder="新工作区名称" required><button>创建</button></form></section><section class="member-section"><div class="section-title"><div><b>成员与角色</b><small>管理员可调整角色、重置密码并移除成员</small></div></div><div id="memberList" class="member-list"></div><form id="memberForm" class="member-form"><div><input id="memberName" placeholder="成员姓名" required><input id="memberEmail" type="email" placeholder="成员邮箱" required></div><div><input id="memberPassword" type="password" minlength="10" maxlength="128" placeholder="初始密码（至少 10 位）" required><select id="memberRole"><option value="member">成员</option><option value="approver">审批人</option><option value="owner">管理员</option></select></div><button>添加成员</button><small>请通过安全方式把初始密码交给成员。</small></form></section><section class="operations-section" id="operationsSection"><div class="section-title"><div><b>运行状态</b><small>队列、失败投递与审计完整性</small></div><em id="operationsState">检查中…</em></div><div id="operationsGrid" class="operations-grid"></div></section><section class="alerts-section" id="alertsSection"><div class="section-title"><div><b>告警中心</b><small>异常可确认，恢复后自动闭环</small></div><em id="alertsState">检查中…</em></div><div id="alertsList" class="alerts-list"></div></section><section class="password-section"><div class="section-title"><div><b>账户安全</b><small>改密后其他登录会话立即失效</small></div></div><p class="password-notice" id="passwordNotice" hidden>当前使用管理员发放的临时密码，完成改密前不能执行写操作。</p><form id="passwordForm" class="password-form"><input id="currentPassword" type="password" minlength="10" maxlength="128" autocomplete="current-password" placeholder="当前密码" required><input id="newPassword" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="新密码（至少 10 位）" required><button>更新密码</button></form></section><section class="automation-section" id="automationSection"><div class="section-title"><div><b>发布自动化</b><small>机器门禁 API Key 与签名 Webhook</small></div></div><div id="apiKeyList" class="automation-list"></div><form id="apiKeyForm" class="inline-create"><input id="apiKeyName" placeholder="API Key 名称" required><button>创建 Key</button></form><div class="one-time-secret" id="apiKeySecret" hidden></div><div id="webhookList" class="automation-list webhook-list"></div><form id="webhookForm" class="automation-form"><input id="webhookName" placeholder="Webhook 名称" required><input id="webhookUrl" type="url" placeholder="https://example.com/shipwitness" required><button>添加 Webhook</button></form><div class="one-time-secret" id="webhookSecret" hidden></div></section><section class="governance-section" id="governanceSection"><div class="section-title"><div><b>合规与数据治理</b><small>导出可验证审计，清理到期运营数据</small></div></div><div class="audit-export-row"><div><b id="auditExportSummary">尚未生成导出</b><small>导出包含完整性证明与操作者目录</small></div><button id="createAuditExport">生成审计导出</button></div><a id="downloadAuditExport" class="audit-download" hidden>下载最近导出</a><form id="retentionForm" class="retention-form"><label><span>运营数据保留</span><select id="operationalDays"><option value="30">30 天</option><option value="90">90 天</option><option value="180">180 天</option><option value="365">365 天</option><option value="730">730 天</option></select></label><button>保存策略</button></form><button id="previewRetention" class="retention-preview">预览到期数据</button><div id="retentionResult" class="retention-result" hidden></div></section><section class="audit-section" id="auditSection"><div class="section-title"><div><b>审计时间线</b><small>关键操作按哈希链顺序记录</small></div><em id="auditIntegrity">校验中…</em></div><div id="auditList" class="audit-list"></div></section></aside><div class="account-mask" id="accountMask" hidden></div><dialog id="memberPasswordDialog" class="member-password-dialog"><form id="memberPasswordResetForm"><header><div><span>账户恢复</span><h3>重置成员密码</h3></div><button type="button" id="cancelMemberPassword">×</button></header><p>保存后该成员所有会话立即退出，下次登录必须修改临时密码。</p><input type="hidden" id="resetMembershipId"><label><span>临时密码</span><input id="resetMemberPassword" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><footer><button type="button" id="cancelMemberPasswordFooter">取消</button><button type="submit">确认重置</button></footer></form></dialog>`);
document.querySelector('.member-section .section-title small').textContent = '成员通过一次性链接自行设置密码';
memberForm.innerHTML = '<div><input id="memberName" placeholder="成员姓名（可选）"><input id="memberEmail" type="email" placeholder="成员邮箱" required></div><div><select id="memberRole"><option value="member">成员</option><option value="approver">审批人</option><option value="owner">管理员</option></select><select id="invitationExpiry"><option value="24">24 小时有效</option><option value="72" selected>3 天有效</option><option value="168">7 天有效</option></select></div><button>生成邀请链接</button><small>链接只显示一次；成员接受后自行设置密码。</small>';
memberList.insertAdjacentHTML('afterend', '<div id="invitationList" class="invitation-list"></div>');
memberForm.insertAdjacentHTML('afterend', '<div class="one-time-secret" id="invitationSecret" hidden></div>');
let authMode = 'login';
let currentSession = null;
let invitationToken = null;
let invitationDetails = null;
const showAuth = mode => {
  authMode = mode; authGate.hidden = false; document.body.classList.add('auth-locked');
  const setup = mode === 'setup'; workspaceField.hidden = !setup; nameField.hidden = !setup; emailField.hidden = false; authEmail.required = true; authName.required = setup;
  authTitle.textContent = setup ? '创建第一个安全工作区' : '登录 ShipWitness';
  authEyebrow.textContent = setup ? '首次初始化' : '安全工作区';
  authDescription.textContent = setup ? '创建本机管理员。现有项目数据会安全归入这个工作区。' : '验收证据、返工单和发布决定只对工作区成员可见。';
  authSubmit.textContent = setup ? '创建并进入工作区' : '登录';
  authPassword.autocomplete = setup ? 'new-password' : 'current-password';
};
const showInvitation = (details, token) => {
  invitationToken = token; invitationDetails = details; authMode = 'invite'; authGate.hidden = false; document.body.classList.add('auth-locked');
  workspaceField.hidden = true; emailField.hidden = true; authEmail.required = false; nameField.hidden = details.existingAccount; authName.required = !details.existingAccount;
  authName.value = ''; authEmail.value = '';
  authEyebrow.textContent = '工作区邀请'; authTitle.textContent = `加入 ${details.workspace.name}`;
  authDescription.textContent = details.existingAccount ? `邀请发送给 ${details.maskedEmail}。请输入现有账号密码确认身份。` : `邀请发送给 ${details.maskedEmail}。请设置姓名和自己的登录密码。`;
  authSubmit.textContent = '接受邀请并进入'; authPassword.autocomplete = details.existingAccount ? 'current-password' : 'new-password'; authPassword.value = '';
};
const hideAuth = session => { currentSession = session; authGate.hidden = true; document.body.classList.remove('auth-locked'); accountBtn.textContent = `${session.workspace.name} · ${session.user.name}`; };

authForm.onsubmit = async event => {
  event.preventDefault(); authSubmit.disabled = true; authError.hidden = true;
  try {
    const path = authMode === 'setup' ? '/api/setup' : authMode === 'invite' ? `/api/invitations/${invitationToken}` : '/api/login';
    const payload = authMode === 'invite' ? { password: authPassword.value, ...(!invitationDetails.existingAccount ? { name: authName.value } : {}) } : { email: authEmail.value, password: authPassword.value, ...(authMode === 'setup' ? { workspaceName: authWorkspace.value, name: authName.value } : {}) };
    const session = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    if (authMode === 'invite') history.replaceState({}, '', location.pathname);
    hideAuth(session); await bootstrapBackend(); if (session.user.mustChangePassword) { await loadAccountPanel(); toast('请先修改管理员发放的临时密码'); }
  } catch (error) { authError.textContent = error.message; authError.hidden = false; }
  finally { authSubmit.disabled = false; }
};
logoutBtn.onclick = async () => { try { await api('/api/logout', { method: 'POST' }); location.reload(); } catch (error) { toast(error.message); } };
const roleLabel = role => ({ owner: '管理员', approver: '审批人', member: '成员' }[role] || role);
const toggleAccount = open => { accountPanel.classList.toggle('open', open); accountPanel.setAttribute('aria-hidden', String(!open)); accountMask.hidden = !open; };
async function loadAccountPanel() {
  const canAudit = ['owner', 'approver'].includes(currentSession?.role);
  const isOwner = currentSession?.role === 'owner';
  const alerts = canAudit ? await api('/api/alerts/refresh', { method: 'POST' }) : [];
  const [workspaces, members, audit, integrity, apiKeys, webhooks, operations, retention, auditExports, invitations] = await Promise.all([api('/api/workspaces'), api('/api/members'), canAudit ? api('/api/audit?limit=30') : [], canAudit ? api('/api/audit/verify') : null, isOwner ? api('/api/api-keys') : [], isOwner ? api('/api/webhooks') : [], canAudit ? api('/api/system/status') : null, isOwner ? api('/api/retention') : null, canAudit ? api('/api/audit-exports') : [], isOwner ? api('/api/invitations') : []]);
  workspaceList.innerHTML = workspaces.map(item => `<button data-workspace-id="${item.id}" ${item.current ? 'disabled' : ''}><span><b>${escapeHtml(item.name)}</b><small>${item.current ? '当前工作区' : '点击切换'}</small></span><em>${item.current ? '当前' : '切换'}</em></button>`).join('');
  memberList.innerHTML = members.map(item => `<article><span>${escapeHtml(item.name).slice(0, 1).toUpperCase()}</span><div><b>${escapeHtml(item.name)}${item.id === currentSession.user.id ? ' · 我' : ''}</b><small>${escapeHtml(item.email)}${item.mustChangePassword ? ' · 待改密' : ''}</small></div>${isOwner ? `<select data-member-role="${item.membershipId}"><option value="member" ${item.role === 'member' ? 'selected' : ''}>成员</option><option value="approver" ${item.role === 'approver' ? 'selected' : ''}>审批人</option><option value="owner" ${item.role === 'owner' ? 'selected' : ''}>管理员</option></select><div class="member-actions">${item.id === currentSession.user.id ? '' : `<button data-reset-member="${item.membershipId}" data-member-name="${escapeHtml(item.name)}">重置密码</button>`}<button data-remove-member="${item.membershipId}" aria-label="移除 ${escapeHtml(item.name)}">移除</button></div>` : `<em>${roleLabel(item.role)}</em>`}</article>`).join('');
  invitationList.hidden = !isOwner; invitationList.innerHTML = isOwner ? invitations.slice(0, 8).map(item => `<article><div><b>${escapeHtml(item.email)}</b><small>${roleLabel(item.role)} · ${item.status === 'pending' ? `等待接受，${new Date(item.expiresAt).toLocaleString('zh-CN')} 到期` : item.status === 'accepted' ? '已接受' : item.status === 'expired' ? '已过期' : '已撤销'}</small></div>${item.status === 'pending' ? `<button data-revoke-invitation="${item.id}">撤销</button>` : `<em>${item.status === 'accepted' ? '完成' : '失效'}</em>`}</article>`).join('') : '';
  memberForm.hidden = currentSession?.role !== 'owner';
  automationSection.hidden = !isOwner;
  governanceSection.hidden = !canAudit;
  retentionForm.hidden = !isOwner; previewRetention.hidden = !isOwner;
  if (isOwner) operationalDays.value = String(retention.operationalDays);
  const latestExport = auditExports[0];
  auditExportSummary.textContent = latestExport ? `${latestExport.eventCount} 条事件 · ${new Date(latestExport.createdAt).toLocaleString('zh-CN')}` : '尚未生成导出';
  downloadAuditExport.hidden = !latestExport; if (latestExport) downloadAuditExport.href = latestExport.downloadUrl;
  operationsSection.hidden = !canAudit;
  alertsSection.hidden = !canAudit;
  passwordNotice.hidden = !currentSession.user.mustChangePassword;
  if (canAudit) {
    const healthy = operations.audit.valid && operations.runs.stale === 0 && operations.webhooks.failed === 0;
    operationsState.textContent = healthy ? '运行正常' : '需要处理'; operationsState.className = healthy ? 'valid' : 'invalid';
    operationsGrid.innerHTML = `<article><b>${operations.runs.running}</b><small>执行中</small></article><article><b>${operations.runs.queued}</b><small>排队任务</small></article><article><b>${operations.runs.failed}</b><small>失败任务</small></article><article><b>${operations.webhooks.pending}</b><small>待投递</small></article><article><b>${operations.webhooks.failed}</b><small>投递失败</small></article><article><b>${operations.audit.valid ? '完整' : '异常'}</b><small>审计链</small></article>`;
    const activeAlerts = alerts.filter(item => item.status !== 'resolved');
    alertsState.textContent = activeAlerts.length ? `${activeAlerts.length} 条待处理` : '暂无告警'; alertsState.className = activeAlerts.length ? 'invalid' : 'valid';
    alertsList.innerHTML = alerts.slice(0, 12).map(item => `<article class="${item.severity} ${item.status}"><i></i><div><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail)}</small><span>${item.status === 'open' ? '未确认' : item.status === 'acknowledged' ? '已确认' : '已解决'} · ${new Date(item.lastSeenAt || item.createdAt).toLocaleString('zh-CN')}</span></div>${item.status === 'open' ? `<button data-ack-alert="${item.id}">确认</button>` : '<em>已记录</em>'}</article>`).join('') || '<p>当前没有需要处理的运行异常</p>';
  }
  if (isOwner) {
    apiKeyList.innerHTML = apiKeys.map(item => `<article><div><b>${escapeHtml(item.name)}</b><small>${item.scopes.join(' · ')} · …${item.tokenSuffix}</small></div>${item.revokedAt ? '<em>已撤销</em>' : `<button data-revoke-key="${item.id}">撤销</button>`}</article>`).join('') || '<p>尚未创建机器 API Key</p>';
    webhookList.innerHTML = webhooks.map(item => `<article><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.url)}</small></div>${item.enabled ? `<button data-disable-webhook="${item.id}">停用</button>` : '<em>已停用</em>'}</article>`).join('') || '<p>尚未配置 Webhook</p>';
  }
  auditSection.hidden = !canAudit;
  if (canAudit) {
    auditIntegrity.textContent = integrity.valid ? `链完整 · ${integrity.checked} 条` : `链异常 · ${integrity.brokenEventId}`; auditIntegrity.className = integrity.valid ? 'valid' : 'invalid';
    auditList.innerHTML = audit.map(item => `<article><i></i><div><b>${escapeHtml(({ 'workspace.initialized': '初始化工作区', 'user.login': '用户登录', 'user.logout': '用户退出', 'user.password_changed': '修改账户密码', 'member.password_reset': '管理员重置成员密码', 'invitation.created': '创建成员邀请', 'invitation.accepted': '接受成员邀请', 'invitation.revoked': '撤销成员邀请', 'workspace.created': '创建工作区', 'workspace.selected': '切换工作区', 'member.added': '添加成员', 'member.role_changed': '调整成员角色', 'member.removed': '移除工作区成员', 'alert.opened': '产生运行告警', 'alert.acknowledged': '确认运行告警', 'alert.resolved': '解决运行告警', 'audit.exported': '生成审计导出', 'retention.updated': '更新数据保留策略', 'retention.cleaned': '清理到期运营数据', 'project.created': '创建项目', 'project.updated': '更新项目', 'contract.created': '创建验收标准', 'contract.updated': '更新验收标准', 'run.created': '创建验收任务', 'run.retry_created': '创建验收重试', 'run.started': '开始执行', 'run.recovered': '接管超时验收任务', 'run.completed': '完成验收', 'issue.created': '创建返工单', 'issue.status_changed': '更新返工状态', 'issue.retest_created': '创建定向复验', 'issue.exported': '导出返工单', 'release.decision_recorded': '签署发布决定', 'api_key.created': '创建机器 API Key', 'api_key.revoked': '撤销机器 API Key', 'webhook.created': '创建发布 Webhook', 'webhook.disabled': '停用发布 Webhook', 'webhook.queued': 'Webhook 已入队', 'webhook.delivered': 'Webhook 已送达', 'webhook.failed': 'Webhook 投递失败', 'dossier.signed': '生成签名卷宗', 'security.master_key_rotated': '轮换主加密密钥' }[item.action] || item.action))}</b><small>${escapeHtml(item.actor?.name || '系统')} · ${new Date(item.at).toLocaleString('zh-CN')}</small></div><code>#${item.sequence}</code></article>`).join('') || '<div class="contract-empty">尚无审计事件</div>';
  }
  toggleAccount(true);
}
accountBtn.onclick = () => loadAccountPanel().catch(error => toast(error.message)); closeAccount.onclick = () => toggleAccount(false); accountMask.onclick = () => toggleAccount(false);
workspaceList.onclick = async event => { const button = event.target.closest('[data-workspace-id]'); if (!button || button.disabled) return; await api(`/api/workspaces/${button.dataset.workspaceId}/select`, { method: 'POST' }); location.reload(); };
workspaceForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: newWorkspaceName.value }) }); location.reload(); } catch (error) { toast(error.message); } };
memberForm.onsubmit = async event => { event.preventDefault(); try { const created = await api('/api/invitations', { method: 'POST', body: JSON.stringify({ name: memberName.value, email: memberEmail.value, role: memberRole.value, expiresInHours: Number(invitationExpiry.value) }) }); const link = `${location.origin}${created.invitePath}`; memberForm.reset(); invitationSecret.hidden = false; invitationSecret.innerHTML = `<b>邀请链接只显示一次，请安全发送给 ${escapeHtml(created.email)}</b><code>${escapeHtml(link)}</code>`; await loadAccountPanel(); invitationSecret.hidden = false; toast('一次性邀请已创建'); } catch (error) { toast(error.message); } };
invitationList.onclick = async event => { const button = event.target.closest('[data-revoke-invitation]'); if (!button || !confirm('撤销后，这个邀请链接会立即失效。确认撤销？')) return; try { await api(`/api/invitations/${button.dataset.revokeInvitation}`, { method: 'DELETE' }); await loadAccountPanel(); toast('邀请已撤销'); } catch (error) { toast(error.message); } };
memberList.onchange = async event => { const select = event.target.closest('[data-member-role]'); if (!select) return; try { const result = await api(`/api/members/${select.dataset.memberRole}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }); if (result.id === currentSession.user.id) return location.reload(); await loadAccountPanel(); toast('成员角色已更新'); } catch (error) { toast(error.message); await loadAccountPanel(); } };
memberList.onclick = async event => {
  const reset = event.target.closest('[data-reset-member]');
  if (reset) { resetMembershipId.value = reset.dataset.resetMember; memberPasswordDialog.querySelector('h3').textContent = `重置 ${reset.dataset.memberName} 的密码`; resetMemberPassword.value = ''; memberPasswordDialog.showModal(); return; }
  const button = event.target.closest('[data-remove-member]'); if (!button || !confirm('移除后，该成员在当前工作区的会话和机器 Key 会立即失效。确认移除？')) return;
  try { const result = await api(`/api/members/${button.dataset.removeMember}`, { method: 'DELETE' }); result.self ? location.reload() : await loadAccountPanel(); toast('成员已移除'); } catch (error) { toast(error.message); }
};
const closeMemberPasswordDialog = () => memberPasswordDialog.close();
cancelMemberPassword.onclick = closeMemberPasswordDialog; cancelMemberPasswordFooter.onclick = closeMemberPasswordDialog;
memberPasswordResetForm.onsubmit = async event => { event.preventDefault(); try { const result = await api(`/api/members/${resetMembershipId.value}/password`, { method: 'POST', body: JSON.stringify({ newPassword: resetMemberPassword.value }) }); closeMemberPasswordDialog(); await loadAccountPanel(); toast(`密码已重置，已退出 ${result.sessionsRevoked} 个会话`); } catch (error) { toast(error.message); } };
alertsList.onclick = async event => { const button = event.target.closest('[data-ack-alert]'); if (!button) return; try { await api(`/api/alerts/${button.dataset.ackAlert}`, { method: 'PATCH', body: JSON.stringify({ status: 'acknowledged' }) }); await loadAccountPanel(); toast('告警已确认并写入审计'); } catch (error) { toast(error.message); } };
createAuditExport.onclick = async () => { createAuditExport.disabled = true; try { const item = await api('/api/audit-exports', { method: 'POST' }); auditExportSummary.textContent = `${item.eventCount} 条事件 · 刚刚生成`; downloadAuditExport.href = item.downloadUrl; downloadAuditExport.hidden = false; toast('审计导出已生成，可立即下载'); } catch (error) { toast(error.message); } finally { createAuditExport.disabled = false; } };
retentionForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/retention', { method: 'PUT', body: JSON.stringify({ operationalDays: Number(operationalDays.value) }) }); retentionPreviewState = null; retentionResult.hidden = true; toast('数据保留策略已保存'); await loadAccountPanel(); } catch (error) { toast(error.message); } };
previewRetention.onclick = async () => { try { retentionPreviewState = await api('/api/retention/preview'); const counts = retentionPreviewState.counts; retentionResult.hidden = false; retentionResult.innerHTML = `<b>${retentionPreviewState.total} 条运营数据符合清理条件</b><small>过期会话 ${counts.sessions} · Webhook 投递 ${counts.webhookDeliveries} · 已解决告警 ${counts.alerts} · 已失效邀请 ${counts.invitations}</small>${retentionPreviewState.total ? '<button data-clean-retention>确认清理</button>' : ''}<em>审计、验收记录、截图与签名卷宗不会被删除</em>`; } catch (error) { toast(error.message); } };
retentionResult.onclick = async event => { if (!event.target.closest('[data-clean-retention]') || !retentionPreviewState || !confirm(`将永久清理 ${retentionPreviewState.total} 条到期运营数据，审计证据保留。确认继续？`)) return; try { const result = await api('/api/retention/cleanup', { method: 'POST', body: JSON.stringify({ asOf: retentionPreviewState.asOf, token: retentionPreviewState.token }) }); retentionPreviewState = null; retentionResult.innerHTML = `<b>已清理 ${result.total} 条到期运营数据</b><small>截止 ${new Date(result.cutoff).toLocaleString('zh-CN')}</small>`; toast('到期运营数据已安全清理'); await loadAccountPanel(); } catch (error) { toast(error.message); } };
passwordForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value }) }); currentSession.user.mustChangePassword = false; passwordForm.reset(); toast('密码已更新，其他会话已退出'); await loadAccountPanel(); } catch (error) { toast(error.message); } };
apiKeyForm.onsubmit = async event => { event.preventDefault(); try { const created = await api('/api/api-keys', { method: 'POST', body: JSON.stringify({ name: apiKeyName.value, scopes: ['gate:read', 'dossier:read'] }) }); apiKeySecret.hidden = false; apiKeySecret.innerHTML = `<b>只显示一次，请立即保存</b><code>${escapeHtml(created.token)}</code>`; apiKeyName.value = ''; await loadAccountPanel(); apiKeySecret.hidden = false; } catch (error) { toast(error.message); } };
webhookForm.onsubmit = async event => { event.preventDefault(); try { const created = await api('/api/webhooks', { method: 'POST', body: JSON.stringify({ name: webhookName.value, url: webhookUrl.value, events: ['release.decision'] }) }); webhookSecret.hidden = false; webhookSecret.innerHTML = `<b>签名密钥只显示一次</b><code>${escapeHtml(created.secret)}</code>`; webhookForm.reset(); await loadAccountPanel(); webhookSecret.hidden = false; } catch (error) { toast(error.message); } };
apiKeyList.onclick = async event => { const button = event.target.closest('[data-revoke-key]'); if (!button || !confirm('撤销后，使用这个 Key 的发布流水线会立即失败。确认撤销？')) return; try { await api(`/api/api-keys/${button.dataset.revokeKey}`, { method: 'DELETE' }); await loadAccountPanel(); toast('API Key 已撤销'); } catch (error) { toast(error.message); } };
webhookList.onclick = async event => { const button = event.target.closest('[data-disable-webhook]'); if (!button || !confirm('停用后不再创建新的投递。确认停用？')) return; try { await api(`/api/webhooks/${button.dataset.disableWebhook}`, { method: 'DELETE' }); await loadAccountPanel(); toast('Webhook 已停用'); } catch (error) { toast(error.message); } };

document.body.insertAdjacentHTML('beforeend', `<aside class="run-task-panel" id="runTaskPanel" aria-hidden="true"><header><div><span>真实任务</span><h2>验收执行详情</h2></div><button id="closeRunTask" aria-label="关闭">×</button></header><section class="run-task-state"><div><span id="runTaskId">—</span><strong id="runTaskStatus">等待读取</strong></div><p id="runTaskSummary">从后端读取任务状态和真实执行证据。</p></section><section class="system-evidence" id="systemEvidence"><div class="empty-task">尚未执行检查</div></section><section class="criteria-results"><span class="field-label">验收标准</span><div id="backendCriteria"></div></section><section class="run-decisions" id="runDecisionHistory" hidden></section><footer><p id="runTaskBoundary">只有配置了浏览器步骤和结果断言的标准才可能自动通过。</p><div><button id="recordDecisionBtn" class="decision-action" hidden>记录发布决定</button><button id="executeRunBtn">执行验收</button></div></footer></aside><div class="run-task-mask" id="runTaskMask" hidden></div>`);
document.body.insertAdjacentHTML('beforeend', `<aside class="contracts-panel" id="contractsPanel" aria-hidden="true"><header><div><span>项目资产</span><h2>验收标准库</h2><p>标准会在任务创建时生成独立快照，后续修改不会改变历史验收。</p></div><button id="closeContracts" aria-label="关闭">×</button></header><section class="contracts-toolbar"><div><b id="activeContractCount">0 条启用</b><small>停用标准不会进入新任务</small></div><button id="newContractBtn">＋ 新增标准</button></section><form class="contract-editor" id="contractEditor" hidden><input type="hidden" id="contractEditId"><div class="contract-form-row"><label><span>标准编号</span><input id="contractCode" placeholder="例如 AUTH-02" required></label><label><span>标准名称</span><input id="contractTitle" placeholder="用户能看懂的结果" required></label></div><label><span>正确结果描述</span><textarea id="contractDescription" rows="3" required></textarea></label><div class="contract-form-row"><label><span>分类</span><select id="contractCategory"><option>业务流程</option><option>权限</option><option>数据</option><option>安全</option><option>性能</option></select></label><label><span>级别</span><select id="contractSeverity"><option value="blocker">阻断发布</option><option value="major">重要</option><option value="minor">一般</option></select></label></div><section class="step-builder"><header><div><b>浏览器执行步骤</b><small>至少包含一个“检查”步骤，才可能自动通过</small></div><button type="button" id="addContractStep">＋ 添加步骤</button></header><div id="contractSteps"></div></section><footer><button type="button" class="contract-cancel" id="cancelContractEdit">取消</button><button type="submit" class="contract-save">保存标准</button></footer></form><section class="contract-list" id="contractList"><div class="contract-empty">正在读取标准…</div></section></aside><div class="contracts-mask" id="contractsMask" hidden></div>`);

const syncWizardContracts = contracts => {
  const enabled = contracts.filter(item => item.enabled);
  criteriaList.innerHTML = enabled.map(item => `<label data-contract-id="${item.id}"><input type="checkbox" checked><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.description)}</small></span><em>${escapeHtml(item.code)} · V${item.version}</em></label>`).join('') || '<p class="contract-empty">标准库暂无启用标准，请先添加或启用标准。</p>';
};

const renderContracts = () => {
  const active = backendContracts.filter(item => item.enabled).length;
  contractCount.textContent = active;
  activeContractCount.textContent = `${active} 条启用`;
  contractList.innerHTML = backendContracts.map(item => `<article class="contract-item ${item.enabled ? '' : 'disabled'}" data-id="${item.id}"><div class="contract-item-head"><span>${escapeHtml(item.code)} · V${item.version}</span><em>${item.severity === 'blocker' ? '阻断' : item.severity === 'major' ? '重要' : '一般'}</em></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p><footer><span>${escapeHtml(item.category)} · ${(item.steps || []).length} 个步骤 · ${item.enabled ? '已启用' : '已停用'}</span><div><button data-action="toggle">${item.enabled ? '停用' : '启用'}</button><button data-action="edit">编辑</button></div></footer></article>`).join('') || '<div class="contract-empty">还没有验收标准</div>';
  syncWizardContracts(backendContracts);
};

async function loadContracts({ seed = false } = {}) {
  if (!backendProjectId) return;
  backendContracts = await api(`/api/contracts?projectId=${backendProjectId}`);
  if (seed && !backendContracts.length) {
    for (const contract of defaultContracts) await api('/api/contracts', { method: 'POST', body: JSON.stringify({ projectId: backendProjectId, ...contract }) });
    backendContracts = await api(`/api/contracts?projectId=${backendProjectId}`);
  }
  renderContracts();
}

const setServiceState = (ok, text) => {
  const badge = document.querySelector('.case-id');
  badge.classList.toggle('offline', !ok);
  badge.childNodes[1].textContent = ` ${text} `;
};

const verdictMeta = value => ({
  passed: { label: '可以发布', className: 'success', detail: '所有标准都有真实断言证据。' },
  failed: { label: '不可发布', className: 'danger', detail: '至少一条业务路径未达到标准。' },
  blocked: { label: '执行受阻', className: 'danger', detail: '环境问题阻断了业务验收。' },
  evidence_insufficient: { label: '证据不足', className: 'warning', detail: '仍有标准没有可执行步骤或明确断言。' },
  queued: { label: '等待执行', className: 'warning', detail: '任务已经创建，尚未执行验收。' }
}[value] || { label: '等待验收', className: 'warning', detail: '创建并执行任务后生成发布结论。' });

const criterionResult = (run, index) => run?.execution?.criteriaResults?.[index] || (run?.criteria?.[index] ? { ...run.criteria[index], result: run.status === 'queued' ? 'queued' : 'evidence_insufficient', reason: run.status === 'queued' ? '等待执行器' : '尚无执行证据' } : null);

function renderLiveDashboard(project, run) {
  backendProject = project || null;
  dashboardRun = run || null;
  const heading = document.querySelector('.project-head h1');
  const overline = document.querySelector('.project-head .overline');
  const scope = document.querySelector('.scope');
  const caseStrip = document.querySelector('.case-strip');
  if (!project) {
    heading.innerHTML = '尚未接入项目 <em>发布验收</em>';
    overline.textContent = '项目 / 尚未接入';
    caseStrip.innerHTML = '<button class="case-chip active" disabled><i class="hold"></i><span>没有项目数据<small>先完成项目接入</small></span><b>—</b></button>';
    overallVerdict.textContent = '等待接入'; verdictSummary.textContent = '保存项目目录和测试网址后开始验收。';
    nextAction.innerHTML = '<span class="mini-label">下一步</span><h3>接入第一个项目</h3><p>连接代码目录、测试网址和返工方式。</p><button class="decide" id="dashboardConnect">检查项目接入 <span>→</span></button>';
    document.querySelector('#dashboardConnect').onclick = () => toggleConnect(true);
    return;
  }
  heading.innerHTML = `${escapeHtml(project.name)} <em>发布验收</em>`;
  overline.textContent = `项目 / ${project.name}${run ? ` / ${run.id.toUpperCase()}` : ''}`;
  scope.innerHTML = `<span>当前分支</span><strong><code>${escapeHtml(project.branch)}</code></strong><small>${run ? new Date(run.createdAt).toLocaleString('zh-CN') : '尚未创建验收任务'}</small>`;
  document.querySelector('.case-id b').textContent = run ? run.id.toUpperCase() : '—';

  const criteria = run?.criteria || [];
  if (!criteria.length) {
    caseStrip.innerHTML = '<button class="case-chip active" disabled><i class="hold"></i><span>暂无验收任务<small>从标准库创建任务</small></span><b>—</b></button>';
    pathLabel.textContent = '尚未创建任务'; caseTitle.textContent = '先确认验收标准'; contractText.textContent = '标准会在任务创建时形成不可变快照。';
    stageKicker.textContent = '真实数据'; stageTitle.textContent = '没有可展示的证据'; stageBody.textContent = '点击“新建验收”选择标准并创建任务。'; stageVisual.innerHTML = '<div class="live-empty">等待第一次真实验收</div>';
    const meta = verdictMeta(); overallVerdict.textContent = meta.label; verdictSummary.textContent = meta.detail; verdictMark.className = `verdict-mark ${meta.className}`;
    nextAction.innerHTML = '<span class="mini-label">下一步</span><h3>创建第一次验收</h3><p>选择标准，保存任务快照，再执行浏览器路径。</p><button class="decide" id="dashboardNewRun">新建验收 <span>→</span></button>';
    document.querySelector('#dashboardNewRun').onclick = () => newRunBtn.click();
    return;
  }
  dashboardCriterionIndex = Math.min(dashboardCriterionIndex, criteria.length - 1);
  caseStrip.innerHTML = criteria.map((criterion, index) => {
    const result = criterionResult(run, index); const icon = result.result === 'passed' ? 'pass' : result.result === 'failed' || result.result === 'blocked' ? 'fail' : 'hold';
    return `<button class="case-chip ${index === dashboardCriterionIndex ? 'active' : ''}" data-live-index="${index}"><i class="${icon}"></i><span>${escapeHtml(criterion.title)}<small>${resultLabel(result.result)}</small></span><b>${String(index + 1).padStart(2, '0')}</b></button>`;
  }).join('');
  caseStrip.querySelectorAll('.case-chip').forEach(button => { button.onclick = () => { dashboardCriterionIndex = Number(button.dataset.liveIndex); dashboardStage = 'claim'; renderLiveDashboard(project, run); }; });
  const criterion = criteria[dashboardCriterionIndex];
  const result = criterionResult(run, dashboardCriterionIndex);
  pathLabel.textContent = `${criterion.code || `路径 ${dashboardCriterionIndex + 1}`} · V${criterion.version || 1}`;
  caseTitle.textContent = criterion.title;
  contractText.textContent = criterion.description;
  const stages = {
    claim: { kicker: '验收标准快照', title: '必须证明的用户结果', body: criterion.description, visual: `<div class="record"><div class="record-head"><span>${escapeHtml(criterion.code || '未编号')}</span><code>V${criterion.version || 1}</code></div><blockquote>${escapeHtml(criterion.title)}</blockquote><dl><div><dt>分类</dt><dd>${escapeHtml(criterion.category || '业务流程')}</dd></div><div><dt>级别</dt><dd>${criterion.severity === 'blocker' ? '阻断发布' : '一般'}</dd></div><div><dt>执行步骤</dt><dd>${criterion.steps?.length || 0}</dd></div></dl></div>` },
    action: { kicker: '真实浏览器计划', title: criterion.steps?.length ? `执行 ${criterion.steps.length} 个受限步骤` : '尚未配置浏览器步骤', body: criterion.steps?.length ? '执行器只运行标准快照中允许的动作，不执行任意脚本。' : '没有步骤时不会猜测业务结果。', visual: `<ol class="live-step-list">${(criterion.steps || []).map((step, index) => `<li><b>${index + 1}</b><span>${escapeHtml(stepOptions.find(item => item[0] === step.action)?.[1] || step.action)}<small>${escapeHtml(step.path || step.selector || step.value || '')}</small></span></li>`).join('') || '<li class="empty">请在标准库中添加执行步骤</li>'}</ol>` },
    observe: { kicker: '浏览器观察结果', title: resultLabel(result.result), body: result.reason || '尚未执行', visual: result.screenshotUrl ? `<a class="evidence-shot" href="${result.screenshotUrl}" target="_blank"><img src="${result.screenshotUrl}" alt="${escapeHtml(criterion.title)}截图证据"><span>打开完整截图 ↗</span></a>` : `<div class="observation"><div class="fact-row"><span>完成步骤</span><b>${result.steps?.filter(step => step.status === 'passed').length || 0} / ${result.steps?.length || criterion.steps?.length || 0}</b></div><div class="fact-row"><span>网络响应</span><b>${result.network?.length || 0} 条</b></div><div class="fact-row"><span>最终网址</span><b>${escapeHtml(result.finalUrl || '尚未记录')}</b></div></div>` },
    verdictStage: { kicker: '证据裁决', title: verdictMeta(result.result).label, body: result.reason || verdictMeta(result.result).detail, visual: `<div class="verdict-card"><span>${result.result === 'passed' ? '验收通过' : result.result === 'failed' ? '验收失败' : '不作通过判断'}</span><strong>${verdictMeta(result.result).label}</strong><p>${escapeHtml(result.reason || verdictMeta(result.result).detail)}</p>${['failed', 'blocked'].includes(result.result) ? '<button class="return-work">生成真实返工单</button>' : ''}</div>` }
  };
  const stage = stages[dashboardStage]; stageKicker.textContent = stage.kicker; stageTitle.textContent = stage.title; stageBody.textContent = stage.body; stageVisual.innerHTML = stage.visual;
  stageTime.textContent = run.execution?.finishedAt ? new Date(run.execution.finishedAt).toLocaleTimeString('zh-CN') : '—'; stageDuration.textContent = result.durationMs ? `${result.durationMs} ms` : '—';
  const order = ['claim', 'action', 'observe', 'verdictStage']; const current = order.indexOf(dashboardStage);
  document.querySelectorAll('.proof-node').forEach((node, index) => { node.classList.toggle('active', index === current); node.classList.toggle('completed', index < current); node.onclick = () => { dashboardStage = node.dataset.stage; renderLiveDashboard(project, run); }; });
  document.querySelector('.proof-track').style.setProperty('--proof-progress', `${current / 3 * 88}%`);
  plainBtn.onclick = () => { stageTitle.textContent = result.result === 'passed' ? '这条标准有证据证明通过了' : result.result === 'failed' ? '真实操作没有达到要求' : '目前的证据还不能说明它做对了'; stageBody.textContent = result.reason || '尚未执行'; };
  evidenceBtn.onclick = () => { rawEvidence.textContent = JSON.stringify({ criterion, result }, null, 2); drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); };

  const overall = run.execution?.verdict || (run.status === 'queued' ? 'queued' : 'evidence_insufficient'); const meta = verdictMeta(overall);
  overallVerdict.textContent = meta.label; verdictSummary.textContent = run.execution?.summary || meta.detail; verdictMark.className = `verdict-mark ${meta.className}`;
  const results = criteria.map((_, index) => criterionResult(run, index)); failedCount.textContent = results.filter(item => ['failed', 'blocked'].includes(item.result)).length; holdCount.textContent = results.filter(item => ['queued', 'evidence_insufficient'].includes(item.result)).length; passedCount.textContent = results.filter(item => item.result === 'passed').length;
  if (overall === 'passed') nextAction.innerHTML = '<span class="mini-label">证据门槛已满足</span><h3>审批并签署发布卷宗</h3><p>先由负责人批准发布，再生成可离线验真的 Ed25519 卷宗。</p><button class="decide" id="viewQueueBtn">打开审批面板 <span>→</span></button><button class="text-action" id="dashboardSign">生成签名卷宗</button><button class="text-action" id="dashboardExport">导出普通卷宗</button>';
  else if (overall === 'failed') nextAction.innerHTML = '<span class="mini-label">现在需要处理</span><h3>查看失败路径</h3><p>先核对截图和步骤，再生成返工单。</p><button class="decide" id="viewQueueBtn">查看任务证据 <span>→</span></button>';
  else if (run.status === 'queued') nextAction.innerHTML = '<span class="mini-label">任务已经就绪</span><h3>执行真实浏览器验收</h3><p>执行后保存步骤、网络响应和截图证据。</p><button class="decide" id="viewQueueBtn">打开任务并执行 <span>→</span></button>';
  else nextAction.innerHTML = '<span class="mini-label">证据仍不完整</span><h3>补齐浏览器步骤</h3><p>未配置步骤的标准不会被判定通过。</p><button class="decide" id="dashboardContracts">打开标准库 <span>→</span></button>';
  document.querySelector('#dashboardContracts')?.addEventListener('click', () => contractsBtn.click()); document.querySelector('#dashboardExport')?.addEventListener('click', () => downloadDossier.click()); document.querySelector('#dashboardSign')?.addEventListener('click', async () => { try { const signedDocument = await api(`/api/dossiers/${run.id}/sign`, { method: 'POST' }); const blob = new Blob([JSON.stringify(signedDocument, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `ShipWitness-signed-${run.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); toast('签名卷宗已生成，可用 CLI 离线验签'); } catch (error) { toast(error.message); } });
}

async function bootstrapBackend() {
  try {
    await api('/api/health');
    setServiceState(true, '服务已连接');
    const projects = await api('/api/projects');
    const saved = projects[0];
    if (saved) {
      backendProjectId = saved.id;
      backendProject = saved;
      connectRepo.value = saved.repo;
      connectUrl.value = saved.url;
      connectBranch.value = saved.branch;
      handoffMode.value = saved.handoffMode;
      connectGithubRepo.value = saved.githubRepo || '';
      connectText.textContent = '后端已保存';
      connectBtn.classList.add('partial');
      await loadContracts({ seed: true });
    }
    const runs = await api('/api/runs');
    const projectRuns = saved ? runs.filter(item => item.projectId === saved.id) : [];
    historyList.innerHTML = projectRuns.map((run, index) => { const meta = verdictMeta(run.execution?.verdict || (run.status === 'queued' ? 'queued' : run.status === 'failed' ? 'failed' : 'evidence_insufficient')); return `<article class="${index === 0 ? 'current' : ''}" data-run-id="${run.id}"><i></i><div><header><b>${run.id.toUpperCase()}</b><time>${new Date(run.createdAt).toLocaleString('zh-CN')}</time></header><h3>${escapeHtml(run.requirement)}</h3><p>${run.criteria.length} 条标准 · 第 ${run.attemptNumber || 1} 次 · ${meta.label}</p><span class="history-status ${run.execution?.verdict === 'passed' ? 'pass-status' : run.execution?.verdict === 'failed' || run.status === 'failed' ? 'fail-status' : 'hold-status'}">${meta.label}</span><button class="open-run-detail" data-run-id="${run.id}">查看真实任务</button></div></article>`; }).join('') || '<div class="contract-empty">还没有验收记录</div>';
    const summary = document.querySelectorAll('.history-summary b'); if (summary.length === 3) { summary[0].textContent = projectRuns.length; summary[1].textContent = projectRuns.filter(item => item.status !== 'completed').length; summary[2].textContent = projectRuns.filter(item => item.execution?.verdict === 'passed').length; }
    historyBtn.querySelector('span').textContent = String(projectRuns.length);
    if (runs[0]) {
      backendRunId = projectRuns[0]?.id || runs[0].id;
    }
    renderLiveDashboard(saved, projectRuns[0]);
  } catch {
    setServiceState(false, '后端未启动');
    renderLiveDashboard(null, null);
  }
}

saveConnection.onclick = async () => {
  try {
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: backendProjectId, name: document.querySelector('.project-head h1').childNodes[0].textContent.trim(), repo: connectRepo.value, url: connectUrl.value, branch: connectBranch.value, handoffMode: handoffMode.value, githubRepo: connectGithubRepo.value }) });
    backendProjectId = project.id;
    backendProject = project;
    await loadContracts({ seed: true });
    connectText.textContent = '后端已保存';
    connectBtn.classList.add('partial');
    toggleConnect(false);
    toast('项目配置已保存到后端');
  } catch (error) { toast(error.message); }
};

runPreflight.onclick = async () => {
  if (!backendProjectId) {
    toast('请先保存项目配置');
    saveConnection.disabled = false;
    return;
  }
  runPreflight.disabled = true;
  runPreflight.textContent = '检查中…';
  try {
    const result = await api(`/api/projects/${backendProjectId}/preflight`, { method: 'POST' });
    const names = ['repo', 'url', 'browser', 'handoff'];
    names.forEach(name => {
      const item = document.querySelector(`[data-check="${name}"]`);
      const check = result.checks[name];
      item.className = check.status === 'ready' ? 'ready' : check.status === 'warning' ? 'warning' : 'failed';
      item.querySelector('p').textContent = check.detail;
      item.querySelector('em').textContent = check.status === 'ready' ? '已就绪' : check.status === 'warning' ? '注意' : '未通过';
    });
    const ready = Object.values(result.checks).filter(item => item.status === 'ready').length;
    preflightSummary.innerHTML = `<b>${ready} 项就绪</b> · 后端真实检查`;
    connectText.textContent = `接入 ${ready}/4`;
    toast('后端配置检查已完成');
  } catch (error) { toast(error.message); }
  finally { runPreflight.disabled = false; runPreflight.textContent = '重新检查'; }
};

window.shipwitnessCreateRun = async () => {
  if (!backendProjectId) throw new Error('请先保存项目接入配置');
  const selectedIds = [...document.querySelectorAll('#criteriaList label')].filter(item => item.querySelector('input').checked).map(item => item.dataset.contractId);
  const criteria = backendContracts.filter(item => item.enabled && selectedIds.includes(item.id)).map(item => ({ contractId: item.id, code: item.code, title: item.title, description: item.description, category: item.category, severity: item.severity, steps: item.steps || [], version: item.version }));
  const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ projectId: backendProjectId, requirement: runRequirement.value, criteria }) });
    backendRunId = run.id;
  renderLiveDashboard(backendProject, run);
  return run;
};

const toggleContracts = open => { contractsPanel.classList.toggle('open', open); contractsPanel.setAttribute('aria-hidden', String(!open)); contractsMask.hidden = !open; };
contractsBtn.onclick = async () => { try { await loadContracts(); toggleContracts(true); } catch (error) { toast(error.message); } };
closeContracts.onclick = () => toggleContracts(false);
contractsMask.onclick = () => toggleContracts(false);
const stepOptions = [['goto', '打开路径'], ['click', '点击元素'], ['fill', '填写内容'], ['expectVisible', '检查可见'], ['expectText', '检查文字'], ['expectUrl', '检查网址']];
const renderStepRows = steps => {
  contractSteps.innerHTML = steps.map((step, index) => `<div class="step-row"><span>${index + 1}</span><select class="step-action">${stepOptions.map(([value, label]) => `<option value="${value}" ${step.action === value ? 'selected' : ''}>${label}</option>`).join('')}</select><input class="step-target" value="${escapeHtml(step.path || step.selector || (step.action === 'expectUrl' ? step.value : ''))}" placeholder="路径或元素定位"><input class="step-value" value="${escapeHtml(step.action === 'expectUrl' ? '' : step.value || '')}" placeholder="填写或预期内容（不要填密码）"><button type="button" class="remove-step" aria-label="删除步骤">×</button></div>`).join('') || '<p class="step-empty">尚未配置步骤，执行时会标记为“证据不足”。</p>';
};
const collectSteps = () => [...contractSteps.querySelectorAll('.step-row')].map(row => {
  const action = row.querySelector('.step-action').value;
  const target = row.querySelector('.step-target').value.trim();
  const value = row.querySelector('.step-value').value;
  if (action === 'goto') return { action, path: target };
  if (action === 'expectUrl') return { action, value: target };
  if (action === 'fill' || action === 'expectText') return { action, selector: target, value };
  return { action, selector: target };
});
const openContractEditor = contract => {
  contractEditor.hidden = false;
  contractEditId.value = contract?.id || '';
  contractCode.value = contract?.code || '';
  contractCode.disabled = Boolean(contract);
  contractTitle.value = contract?.title || '';
  contractDescription.value = contract?.description || '';
  contractCategory.value = contract?.category || '业务流程';
  contractSeverity.value = contract?.severity || 'blocker';
  renderStepRows(contract?.steps || []);
  contractEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
addContractStep.onclick = () => { const steps = collectSteps(); steps.push({ action: 'goto', path: '/' }); renderStepRows(steps); };
contractSteps.onclick = event => { if (!event.target.closest('.remove-step')) return; event.target.closest('.step-row').remove(); [...contractSteps.querySelectorAll('.step-row>span')].forEach((item, index) => { item.textContent = index + 1; }); if (!contractSteps.querySelector('.step-row')) renderStepRows([]); };
newContractBtn.onclick = () => openContractEditor();
cancelContractEdit.onclick = () => { contractEditor.hidden = true; };
contractEditor.onsubmit = async event => {
  event.preventDefault();
  const payload = { title: contractTitle.value, description: contractDescription.value, category: contractCategory.value, severity: contractSeverity.value, steps: collectSteps() };
  try {
    if (contractEditId.value) await api(`/api/contracts/${contractEditId.value}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/contracts', { method: 'POST', body: JSON.stringify({ ...payload, projectId: backendProjectId, code: contractCode.value }) });
    contractEditor.hidden = true;
    await loadContracts();
    toast(contractEditId.value ? '标准已更新，新版本已生成' : '标准已加入标准库');
  } catch (error) { toast(error.message); }
};
contractList.onclick = async event => {
  const button = event.target.closest('button');
  const item = event.target.closest('.contract-item');
  if (!button || !item) return;
  const contract = backendContracts.find(value => value.id === item.dataset.id);
  if (button.dataset.action === 'edit') return openContractEditor(contract);
  try { await api(`/api/contracts/${contract.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !contract.enabled }) }); await loadContracts(); toast(contract.enabled ? '标准已停用' : '标准已启用'); }
  catch (error) { toast(error.message); }
};

async function bootstrapApp() {
  try {
    const setup = await api('/api/setup/status');
    if (setup.needsSetup) return showAuth('setup');
    const invite = new URLSearchParams(location.search).get('invite');
    if (invite) { try { return showInvitation(await api(`/api/invitations/${invite}`), invite); } catch (error) { toast(error.message); history.replaceState({}, '', location.pathname); } }
    try { const session = await api('/api/session'); hideAuth(session); await bootstrapBackend(); if (session.user.mustChangePassword) { await loadAccountPanel(); toast('请先修改管理员发放的临时密码'); } }
    catch { showAuth('login'); }
  } catch { setServiceState(false, '后端未启动'); showAuth('login'); }
}
bootstrapApp();

const toggleRunTask = open => { runTaskPanel.classList.toggle('open', open); runTaskPanel.setAttribute('aria-hidden', String(!open)); runTaskMask.hidden = !open; };
const resultLabel = value => ({ ready: '已就绪', passed: '已通过', warning: '注意', failed: '未通过', blocked: '被阻断', evidence_insufficient: '证据不足' }[value] || value);
async function loadRunTask() {
  if (!backendRunId) return toast('还没有后端验收任务');
  const run = await api(`/api/runs/${backendRunId}`);
  const decisions = await api(`/api/decisions?runId=${backendRunId}`);
  renderLiveDashboard(backendProject, run);
  const stale = run.status === 'running' && Date.now() - new Date(run.startedAt || 0).getTime() > 15 * 60_000;
  runTaskId.textContent = `${run.id.toUpperCase()} · 第 ${run.attemptNumber || 1} 次`;
  runTaskStatus.textContent = run.status === 'completed' ? (run.execution?.executor === 'shipwitness-browser-v1' ? '真实验收已完成' : '基础检查已完成') : run.status === 'failed' ? '执行失败' : stale ? '执行超时，可接管' : run.status === 'running' ? '正在执行' : '等待执行';
  runTaskSummary.textContent = run.execution?.summary || run.failure || (stale ? '任务超过 15 分钟未结束，可以安全接管并重新取证。' : '任务已保存，尚未运行任何检查。');
  backendCriteria.innerHTML = (run.execution?.criteriaResults || run.criteria.map(item => ({ ...item, result: 'queued', reason: '等待执行器' }))).map(item => `<article><i class="${item.result}"></i><div><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.reason || item.description)}</p>${item.steps?.length ? `<small>${item.steps.filter(step => step.status === 'passed').length}/${item.steps.length} 步完成</small>` : ''}${item.screenshotUrl ? `<a href="${item.screenshotUrl}" target="_blank">查看截图证据 ↗</a>` : ''}</div><em>${resultLabel(item.result)}</em></article>`).join('');
  runDecisionHistory.hidden = !decisions.length;
  runDecisionHistory.innerHTML = decisions.map(item => `<article><span>${item.verdict === 'approve' ? '批准发布' : '暂不发布'}</span><b>${escapeHtml(item.owner)}</b><p>${escapeHtml(item.note || '无补充说明')} · ${new Date(item.createdAt).toLocaleString('zh-CN')}</p></article>`).join('');
  const canDecide = ['owner', 'approver'].includes(currentSession?.role) && run.status === 'completed';
  recordDecisionBtn.hidden = !canDecide; recordDecisionBtn.dataset.verdict = run.execution?.verdict === 'passed' ? 'approve' : 'hold'; recordDecisionBtn.textContent = run.execution?.verdict === 'passed' ? '批准本次发布' : '记录暂不发布';
  executeRunBtn.disabled = run.status === 'running' && !stale;
  executeRunBtn.dataset.mode = ['completed', 'failed'].includes(run.status) ? 'retry' : 'execute';
  if (run.execution) {
    if (run.execution.executor === 'shipwitness-browser-v1') {
      const passed = run.execution.criteriaResults.filter(item => item.result === 'passed').length;
      const failed = run.execution.criteriaResults.filter(item => item.result === 'failed').length;
      systemEvidence.innerHTML = `<article><span>浏览器引擎</span><b>${run.execution.browser?.status === 'ready' ? 'Chromium 已执行' : '环境不可用'}</b><p>${escapeHtml(run.execution.browser?.error || '真实无头浏览器')}</p></article><article><span>业务断言</span><b>${passed} 条通过</b><p>${failed} 条失败 · ${run.criteria.length - passed - failed} 条证据不足</p></article><article><span>执行器</span><b>Browser v1</b><p>截图、步骤和网络响应已记录</p></article>`;
      runTaskBoundary.textContent = '真实浏览器只对有明确断言且全部成功的标准判定通过。';
      executeRunBtn.textContent = '创建新任务并重试真实验收';
    } else {
      const target = run.execution.target, repository = run.execution.repository;
      systemEvidence.innerHTML = `<article><span>项目目录</span><b>${resultLabel(repository.status)}</b><p>${repository.detail}</p></article><article><span>测试网址</span><b>HTTP ${target.httpStatus ?? '—'}</b><p>${target.title || target.error || target.finalUrl || '无标题'}</p></article><article><span>内容指纹</span><b>${target.contentSha256?.slice(0, 12) || '未生成'}</b><p>${target.durationMs} ms · 检查 ${target.bodyBytesInspected || 0} bytes</p></article>`;
      runTaskBoundary.textContent = '当前任务没有浏览器步骤，只执行了基础环境检查。';
      executeRunBtn.textContent = '创建新任务并重试基础检查';
    }
  } else {
    systemEvidence.innerHTML = '<div class="empty-task">尚未执行基础检查</div>';
    executeRunBtn.textContent = run.status === 'failed' ? '创建新任务并重试' : stale ? '接管超时任务' : run.status === 'running' ? '任务执行中' : '执行基础检查';
  }
  toggleRunTask(true);
}
closeRunTask.onclick = () => toggleRunTask(false); runTaskMask.onclick = () => toggleRunTask(false);
document.addEventListener('click', event => { const trigger = event.target.closest('.open-run-detail') || event.target.closest('#viewQueueBtn'); if (trigger) { if (trigger.dataset.runId) backendRunId = trigger.dataset.runId; loadRunTask().catch(error => toast(error.message)); } });
executeRunBtn.onclick = async () => {
  executeRunBtn.disabled = true; executeRunBtn.textContent = '正在执行与取证…'; runTaskStatus.textContent = '正在执行';
  try { if (executeRunBtn.dataset.mode === 'retry') { const retry = await api(`/api/runs/${backendRunId}/retry`, { method: 'POST' }); backendRunId = retry.id; } await api(`/api/runs/${backendRunId}/execute`, { method: 'POST' }); await loadRunTask(); toast('验收证据已保存，历史任务保持不变'); }
  catch (error) { toast(error.message); }
  finally { executeRunBtn.disabled = false; }
};
recordDecisionBtn.onclick = async () => {
  const verdict = recordDecisionBtn.dataset.verdict; recordDecisionBtn.disabled = true;
  try { await api('/api/decisions', { method: 'POST', body: JSON.stringify({ runId: backendRunId, verdict, note: verdict === 'approve' ? '所有验收标准均有通过证据。' : '当前证据裁决尚未达到发布门槛。' }) }); await loadRunTask(); toast(verdict === 'approve' ? '发布批准已写入审计链' : '暂不发布决定已写入审计链'); }
  catch (error) { toast(error.message); } finally { recordDecisionBtn.disabled = false; }
};

const issueStatusLabel = status => ({ open: '待交回', handed_off: '等待修复', fixed: '等待复验', retesting: '复验中', verified: '复验通过', closed: '已关闭' }[status] || '待创建');
const describeStep = step => {
  const label = stepOptions.find(item => item[0] === step.action)?.[1] || step.action;
  return `${label}：${step.path || step.selector || step.value || '当前页面'}`;
};
const fillIssueDialog = (criterion, result, issue = null) => {
  selectedBackendIssue = issue;
  issueCode.textContent = issue?.id?.toUpperCase() || criterion.code || 'NEW';
  issueTitle.textContent = issue?.title || `${criterion.title}未达到验收标准`;
  issueContract.textContent = criterion.description;
  const steps = issue?.reproductionSteps?.length ? issue.reproductionSteps : (criterion.steps || []).map(describeStep);
  issueSteps.innerHTML = steps.map(step => `<li>${escapeHtml(step)}</li>`).join('') || '<li>当前标准没有可复现步骤</li>';
  issueActual.textContent = issue?.actual || result.reason || '执行结果未达到标准';
  issueExpected.textContent = issue?.expected || criterion.description;
  issuePrompt.textContent = `修复“${criterion.title}”。保持验收标准不变；完成后说明修改位置，并确保以下浏览器路径可以复验：${steps.join('；') || criterion.description}`;
  issueSeverity.textContent = criterion.severity === 'blocker' ? '阻断发布' : criterion.severity === 'major' ? '重要' : '一般';
  issueEvidence.textContent = result.screenshotUrl ? '截图 + 步骤 + 网络记录' : '步骤 + 执行记录';
  issueHandoffMode.textContent = backendProject?.handoffMode === 'github' ? 'GitHub Issue' : backendProject?.handoffMode === 'agent' ? '编码 Agent 交接包' : '本地返工单';
  issueState.textContent = issueStatusLabel(issue?.status);
  issueState.classList.toggle('sent', Boolean(issue));
  handoffIssue.hidden = ['fixed', 'retesting', 'verified', 'closed'].includes(issue?.status);
  handoffIssue.disabled = false;
  handoffIssue.textContent = !issue ? '创建返工单' : issue.status === 'open' ? '标记为已交回' : '已交回，等待修复';
  retestIssue.hidden = !issue || !['handed_off', 'fixed'].includes(issue.status);
  downloadHandoff.hidden = !issue;
  exportGithub.hidden = !issue || backendProject?.handoffMode !== 'github' || Boolean(issue.externalRef);
  exportGithub.textContent = issue?.externalRef ? '已创建 GitHub Issue' : '创建 GitHub Issue';
  issueHint.textContent = issue?.externalRef ? `已交接：${issue.externalRef.url}` : issue ? `状态变化已记录 · ${issue.id}` : '创建后会进入项目验收卷宗。';
};

window.shipwitnessOpenIssue = async () => {
  if (!dashboardRun?.execution) return toast('请先执行真实验收');
  const criterion = dashboardRun.criteria[dashboardCriterionIndex];
  const result = criterionResult(dashboardRun, dashboardCriterionIndex);
  if (!['failed', 'blocked'].includes(result.result)) return toast('只有失败或阻断项需要返工');
  try {
    const issues = await api(`/api/issues?runId=${dashboardRun.id}`);
    const criterionId = criterion.contractId || criterion.code;
    fillIssueDialog(criterion, result, issues.find(item => item.criterionId === criterionId));
    issueDialog.showModal();
  } catch (error) { toast(error.message); }
};

handoffIssue.onclick = async () => {
  const criterion = dashboardRun?.criteria?.[dashboardCriterionIndex];
  const result = criterion && criterionResult(dashboardRun, dashboardCriterionIndex);
  if (!criterion || !result) return toast('没有可处理的失败证据');
  handoffIssue.disabled = true;
  try {
    if (!selectedBackendIssue) {
      selectedBackendIssue = await api('/api/issues', { method: 'POST', body: JSON.stringify({ runId: dashboardRun.id, criterionId: criterion.contractId || criterion.code, title: `${criterion.title}未达到验收标准`, contract: criterion.description, reproductionSteps: (criterion.steps || []).map(describeStep), actual: result.reason, expected: criterion.description }) });
      fillIssueDialog(criterion, result, selectedBackendIssue);
      toast('真实返工单已创建');
    } else if (selectedBackendIssue.status === 'open') {
      selectedBackendIssue = await api(`/api/issues/${selectedBackendIssue.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'handed_off', note: '已交回开发处理' }) });
      fillIssueDialog(criterion, result, selectedBackendIssue);
      toast('返工单已标记为等待修复');
    }
  } catch (error) { toast(error.message); }
  finally { handoffIssue.disabled = false; }
};

retestIssue.onclick = async () => {
  if (!selectedBackendIssue) return;
  retestIssue.disabled = true;
  try {
    const created = await api(`/api/issues/${selectedBackendIssue.id}/retest`, { method: 'POST' });
    backendRunId = created.run.id;
    issueDialog.close();
    await loadRunTask();
    toast('定向复验任务已创建，只执行当前失败路径');
  } catch (error) { toast(error.message); }
  finally { retestIssue.disabled = false; }
};

downloadHandoff.onclick = async () => {
  if (!selectedBackendIssue) return;
  try {
    const data = await api(`/api/issues/${selectedBackendIssue.id}/handoff`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `ShipWitness-handoff-${selectedBackendIssue.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); toast('编码 Agent 交接包已生成');
  } catch (error) { toast(error.message); }
};
exportGithub.onclick = async () => {
  if (!selectedBackendIssue) return; exportGithub.disabled = true;
  try { selectedBackendIssue = await api(`/api/issues/${selectedBackendIssue.id}/export/github`, { method: 'POST' }); fillIssueDialog(dashboardRun.criteria[dashboardCriterionIndex], criterionResult(dashboardRun, dashboardCriterionIndex), selectedBackendIssue); toast('GitHub Issue 已创建并写入审计链'); }
  catch (error) { toast(error.message); } finally { exportGithub.disabled = false; }
};

signDecision.onclick = async () => {
  if (!backendRunId) return toast('请先创建验收任务');
  const owner = ownerName.value.trim();
  try {
    await api('/api/decisions', { method: 'POST', body: JSON.stringify({ runId: backendRunId, owner, verdict: 'hold', note: '存在阻断问题，暂不发布' }) });
    paperSign.textContent = `${owner} · 已确认暂不发布 · 后端已记录`;
    paperSign.classList.add('signed');
    signDecision.textContent = '决定已写入后端';
    signDecision.disabled = true;
    toast('暂不发布决定已保存到后端');
  } catch (error) { toast(error.message); }
};

downloadDossier.onclick = async () => {
  if (!backendRunId) return toast('请先创建验收任务');
  try {
    const data = await api(`/api/dossiers/${backendRunId}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ShipWitness-${backendRunId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    toast('后端验收卷宗已生成');
  } catch (error) { toast(error.message); }
};
exportBtn.onclick = () => downloadDossier.click();
