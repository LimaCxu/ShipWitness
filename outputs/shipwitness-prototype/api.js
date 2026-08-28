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
let backendProjects = [];
let dashboardRun = null;
let dashboardCriterionIndex = 0;
let dashboardStage = 'claim';
let selectedBackendIssue = null;
let retentionPreviewState = null;
let latestReadiness = null;
let latestDeploymentConfiguration = null;
let pendingSecurityFindingAction = null;
let actionConfirmationResolver = null;
let pendingFeedbackAction = null;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
const downloadJson = (value, filename) => { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); };
const defaultContracts = [
  { code: 'AUTH-01', title: '权限隔离', description: '普通成员看不到管理入口，也不能通过网址直接进入后台。', category: '权限', severity: 'blocker' },
  { code: 'DATA-01', title: '资料保存', description: '出现“保存成功”后刷新页面，新资料仍然存在。', category: '数据', severity: 'blocker' },
  { code: 'DELETE-01', title: '删除客户', description: '管理员可以删除客户，且删除后的恢复方式必须符合产品决定。', category: '业务流程', severity: 'major' },
  { code: 'SESSION-01', title: '安全退出', description: '退出后访问受保护页面，必须返回登录页。', category: '安全', severity: 'blocker' }
];

document.body.insertAdjacentHTML('beforeend', `<div class="auth-gate" id="authGate" hidden><section class="auth-card"><div class="auth-brand"><span>S</span><div><b>ShipWitness</b><small>发布验收台</small></div></div><div class="auth-copy"><span id="authEyebrow">安全工作区</span><h1 id="authTitle">登录 ShipWitness</h1><p id="authDescription">验收证据、返工单和发布决定只对工作区成员可见。</p></div><section id="setupOverview" class="setup-overview" hidden><div class="setup-progress"><span class="active">1 部署预检</span><i></i><span>2 创建管理员</span></div><div id="setupCheckList" class="setup-check-list"></div><p id="setupBoundary"></p></section><form id="authForm"><label id="workspaceField" hidden><span>工作区名称</span><input id="authWorkspace" autocomplete="organization" value="我的工作区"></label><label id="nameField" hidden><span>你的姓名</span><input id="authName" autocomplete="name" value="管理员"></label><label id="emailField"><span>邮箱</span><input id="authEmail" type="email" autocomplete="username" required placeholder="owner@example.com"></label><label id="passwordField"><span>密码</span><input id="authPassword" type="password" autocomplete="current-password" minlength="10" required placeholder="至少 10 个字符"></label><label id="resetConfirmField" hidden><span>再次输入新密码</span><input id="authPasswordConfirm" type="password" autocomplete="new-password" minlength="10" maxlength="128" placeholder="再次输入新密码"></label><label id="mfaCodeField" hidden><span>动态验证码或恢复码</span><input id="authMfaCode" autocomplete="one-time-code" inputmode="numeric" maxlength="20" placeholder="6 位动态验证码"></label><p class="auth-error" id="authError" hidden></p><button type="submit" id="authSubmit">登录</button><button type="button" id="forgotPassword" class="auth-link">忘记密码</button></form><footer>本地私有部署 · 会话使用 HttpOnly 安全 Cookie</footer></section></div>`);
const accountSlot = document.createElement('div'); accountSlot.className = 'account-slot'; accountSlot.innerHTML = '<button id="feedbackBtn" class="feedback-button">反馈</button><button id="inboxBtn" class="inbox-button">待办<span id="inboxBadge" hidden>0</span></button><button id="accountBtn">—</button><button id="logoutBtn">退出</button>'; document.querySelector('.bar-actions').prepend(accountSlot);
const projectSlot = document.createElement('div'); projectSlot.className = 'project-slot'; projectSlot.innerHTML = '<button id="portfolioBtn" class="portfolio-button" type="button">项目总览</button><button id="projectSwitchBtn" class="project-switch" type="button" aria-expanded="false"><span>当前项目</span><b>尚未接入</b><i>⌄</i></button><div id="projectMenu" class="project-menu" hidden></div>'; accountSlot.before(projectSlot);
document.body.insertAdjacentHTML('beforeend', `<aside class="account-panel" id="accountPanel" aria-hidden="true"><header><div><span>组织、权限与自动化</span><h2>工作区管理</h2></div><button id="closeAccount" aria-label="关闭">×</button></header><section class="workspace-section"><div class="section-title"><div><b>我的工作区</b><small>切换后只显示该工作区的数据</small></div></div><div id="workspaceList" class="workspace-list"></div><form id="workspaceForm" class="inline-create"><input id="newWorkspaceName" placeholder="新工作区名称" required><button>创建</button></form></section><section class="member-section"><div class="section-title"><div><b>成员与角色</b><small>管理员可调整角色、重置密码并移除成员</small></div></div><div id="memberList" class="member-list"></div><form id="memberForm" class="member-form"><div><input id="memberName" placeholder="成员姓名" required><input id="memberEmail" type="email" placeholder="成员邮箱" required></div><div><input id="memberPassword" type="password" minlength="10" maxlength="128" placeholder="初始密码（至少 10 位）" required><select id="memberRole"><option value="member">成员</option><option value="approver">审批人</option><option value="owner">管理员</option></select></div><button>添加成员</button><small>请通过安全方式把初始密码交给成员。</small></form></section><section class="operations-section" id="operationsSection"><div class="section-title"><div><b>运行状态</b><small>队列、失败投递与审计完整性</small></div><em id="operationsState">检查中…</em></div><div id="operationsGrid" class="operations-grid"></div></section><section class="alerts-section" id="alertsSection"><div class="section-title"><div><b>告警中心</b><small>异常可确认，恢复后自动闭环</small></div><em id="alertsState">检查中…</em></div><div id="alertsList" class="alerts-list"></div></section><section class="password-section"><div class="section-title"><div><b>账户安全</b><small>改密后其他登录会话立即失效</small></div></div><p class="password-notice" id="passwordNotice" hidden>当前使用管理员发放的临时密码，完成改密前不能执行写操作。</p><form id="passwordForm" class="password-form"><input id="currentPassword" type="password" minlength="10" maxlength="128" autocomplete="current-password" placeholder="当前密码" required><input id="newPassword" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="新密码（至少 10 位）" required><button>更新密码</button></form></section><section class="automation-section" id="automationSection"><div class="section-title"><div><b>发布自动化</b><small>机器门禁 API Key 与签名 Webhook</small></div></div><div id="apiKeyList" class="automation-list"></div><form id="apiKeyForm" class="inline-create"><input id="apiKeyName" placeholder="API Key 名称" required><button>创建 Key</button></form><div class="one-time-secret" id="apiKeySecret" hidden></div><div id="webhookList" class="automation-list webhook-list"></div><form id="webhookForm" class="automation-form"><input id="webhookName" placeholder="Webhook 名称" required><input id="webhookUrl" type="url" placeholder="https://example.com/shipwitness" required><button>添加 Webhook</button></form><div class="one-time-secret" id="webhookSecret" hidden></div></section><section class="governance-section" id="governanceSection"><div class="section-title"><div><b>合规与数据治理</b><small>导出可验证审计，清理到期运营数据</small></div></div><div class="audit-export-row"><div><b id="auditExportSummary">尚未生成导出</b><small>导出包含完整性证明与操作者目录</small></div><button id="createAuditExport">生成审计导出</button></div><a id="downloadAuditExport" class="audit-download" hidden>下载最近导出</a><form id="retentionForm" class="retention-form"><label><span>运营数据保留</span><select id="operationalDays"><option value="30">30 天</option><option value="90">90 天</option><option value="180">180 天</option><option value="365">365 天</option><option value="730">730 天</option></select></label><button>保存策略</button></form><button id="previewRetention" class="retention-preview">预览到期数据</button><div id="retentionResult" class="retention-result" hidden></div></section><section class="audit-section" id="auditSection"><div class="section-title"><div><b>审计时间线</b><small>关键操作按哈希链顺序记录</small></div><em id="auditIntegrity">校验中…</em></div><div id="auditList" class="audit-list"></div></section></aside><div class="account-mask" id="accountMask" hidden></div><dialog id="memberPasswordDialog" class="member-password-dialog"><form id="memberPasswordResetForm"><header><div><span>账户恢复</span><h3>重置成员密码</h3></div><button type="button" id="cancelMemberPassword">×</button></header><p>保存后该成员所有会话立即退出，下次登录必须修改临时密码。</p><input type="hidden" id="resetMembershipId"><label><span>临时密码</span><input id="resetMemberPassword" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><footer><button type="button" id="cancelMemberPasswordFooter">取消</button><button type="submit">确认重置</button></footer></form></dialog>`);
document.querySelector('.automation-section .section-title small').textContent = '按用途最小授权的机器 API Key 与签名 Webhook';
automationSection.insertAdjacentHTML('afterbegin', '<div class="acceptance-secret-section"><div class="section-title"><div><b>验收凭据保险箱</b><small>登录密码等敏感内容加密保存，任务与证据只记录引用名</small></div></div><div id="acceptanceSecretList" class="automation-list"></div><form id="acceptanceSecretForm" class="acceptance-secret-form"><input id="acceptanceSecretId" type="hidden"><input id="acceptanceSecretName" maxlength="64" placeholder="凭据名，如 LOGIN_PASSWORD" pattern="[A-Za-z][A-Za-z0-9_]{1,63}" required><input id="acceptanceSecretValue" type="password" maxlength="10000" autocomplete="new-password" placeholder="凭据值（保存后不再显示）" required><select id="acceptanceSecretExpiry" aria-label="轮换周期"><option value="30">30 天</option><option value="90" selected>90 天</option><option value="180">180 天</option><option value="365">365 天</option></select><button id="acceptanceSecretSubmit">安全保存</button><button id="cancelAcceptanceSecretRotation" type="button" hidden>取消</button></form><p class="secret-boundary">在填写步骤中使用 <code>{{secret:LOGIN_PASSWORD}}</code>，不要把真实密码写进验收标准。到期后任务会被阻断；轮换会重新计算有效期。</p><datalist id="acceptanceSecretRefs"></datalist></div>');
document.querySelector('.password-section').insertAdjacentHTML('beforeend', '<div class="mfa-management"><div><b>两步验证</b><small id="mfaStatusText">读取中…</small></div><button id="manageMfa" type="button">设置</button></div>');
document.querySelector('.password-section').insertAdjacentHTML('beforeend', '<div class="session-management"><div class="section-title"><div><b>登录设备</b><small>发现陌生设备时可单独退出，不影响当前操作</small></div><em id="sessionCount">读取中…</em></div><div id="sessionList" class="session-list"></div></div>');
document.body.insertAdjacentHTML('beforeend', `<dialog id="mfaDialog" class="mfa-dialog"><form id="mfaForm"><header><div><span>账户安全</span><h3 id="mfaDialogTitle">启用两步验证</h3><p id="mfaDialogDescription">使用当前密码确认身份。</p></div><button type="button" id="closeMfaDialog">×</button></header><label id="mfaPasswordLabel"><span>当前密码</span><input id="mfaCurrentPassword" type="password" autocomplete="current-password" minlength="10" maxlength="128"></label><section id="mfaSetupDetails" hidden><p>在验证器应用中手动输入下面的密钥，然后填写生成的 6 位验证码。</p><code id="mfaSetupSecret"></code></section><label id="mfaVerifyLabel" hidden><span>动态验证码或恢复码</span><input id="mfaVerifyCode" autocomplete="one-time-code" maxlength="20" placeholder="6 位动态验证码"></label><section id="mfaRecoveryCodes" class="mfa-recovery-codes" hidden></section><p id="mfaError" class="auth-error" hidden></p><footer><button type="button" id="cancelMfaDialog">取消</button><button type="submit" id="submitMfa">继续</button></footer></form></dialog>`);
apiKeyName.insertAdjacentHTML('afterend', '<select id="apiKeyPurpose" aria-label="API Key 用途"><option value="ci">只读发布流水线</option><option value="agent">Coding Agent 验收</option></select>');
document.querySelector('.member-section .section-title small').textContent = '成员通过一次性链接自行设置密码';
document.querySelector('.workspace-section').insertAdjacentHTML('beforebegin', '<section class="identity-section"><div class="section-title"><div><b>身份信息</b><small>用于审批签署、审计记录和团队协作</small></div></div><form id="profileForm" class="identity-form"><label><span>显示名称</span><input id="profileName" maxlength="100" autocomplete="name" required></label><label><span>登录邮箱</span><input id="profileEmail" type="email" disabled></label><button>保存个人资料</button></form><form id="workspaceIdentityForm" class="identity-form workspace-identity-form"><label><span>当前工作区名称</span><input id="workspaceIdentityName" maxlength="120" autocomplete="organization" required></label><button>重命名工作区</button></form></section>');
memberForm.innerHTML = '<div><input id="memberName" placeholder="成员姓名（可选）"><input id="memberEmail" type="email" placeholder="成员邮箱" required></div><div><select id="memberRole"><option value="member">成员</option><option value="approver">审批人</option><option value="owner">管理员</option></select><select id="invitationExpiry"><option value="24">24 小时有效</option><option value="72" selected>3 天有效</option><option value="168">7 天有效</option></select></div><button>生成邀请链接</button><small>链接只显示一次；成员接受后自行设置密码。</small>';
memberList.insertAdjacentHTML('afterend', '<div id="invitationList" class="invitation-list"></div>');
memberForm.insertAdjacentHTML('afterend', '<div class="one-time-secret" id="invitationSecret" hidden></div>');
automationSection.insertAdjacentHTML('beforeend', '<div class="email-settings"><div class="section-title"><div><b>邮件通知</b><small>邀请、验收失败和待审批主动触达</small></div><em id="emailState">检查中…</em></div><p id="emailHint">SMTP 由部署环境安全配置。</p><button id="sendTestEmail" type="button">发送测试邮件</button><div id="emailDeliveryList" class="automation-list email-delivery-list"></div></div>');
operationsSection.insertAdjacentHTML('beforebegin', '<section id="readinessSection" class="readiness-section"><div class="section-title"><div><b>上线就绪中心</b><small>区分本地可用、受控试点和公网候选</small></div><button id="exportReadiness" type="button">导出报告</button></div><div id="readinessVerdict" class="readiness-verdict"><span>检查中…</span></div><div id="readinessChecks" class="readiness-checks"></div></section>');
governanceSection.insertAdjacentHTML('beforebegin', '<section id="backupSection" class="backup-section"><div class="section-title"><div><b>备份与恢复</b><small>创建可校验恢复点，并在隔离数据库证明能够恢复</small></div><button id="createBackup" type="button">创建备份</button></div><div id="backupState" class="backup-state">正在读取…</div><div id="backupList" class="backup-list"></div><div id="backupPreflight" class="backup-preflight" hidden></div><div class="recovery-drill-head"><b>恢复演练记录</b><small id="recoveryDrillState">正在读取…</small></div><div id="recoveryDrillList" class="recovery-drill-list"></div></section>');
readinessSection.insertAdjacentHTML('afterend', '<section id="securityReviewSection" class="security-review-section"><div class="section-title"><div><b>安全评审中心</b><small>把外部报告变成整改、复测和发布门禁</small></div><em id="securityReviewState">尚未登记</em></div><div id="securityReviewList" class="security-review-list"></div><form id="securityReviewForm" class="security-review-form"><div><input id="securityProvider" placeholder="评审机构" required><input id="securityReference" placeholder="报告编号" required><input id="securityReviewedAt" type="date" required></div><input id="securityScope" placeholder="评审范围" required><textarea id="securitySummary" placeholder="评审摘要" required></textarea><div class="security-finding-fields"><select id="securitySeverity"><option value="">没有发现项</option><option value="critical">严重</option><option value="high">高危</option><option value="medium">中危</option><option value="low">低危</option></select><input id="securityFindingTitle" placeholder="发现标题（可选）"><input id="securityFindingDescription" placeholder="发现说明（可选）"></div><button>登记安全评审</button></form></section>');
document.body.insertAdjacentHTML('beforeend', `<dialog id="securityFindingDialog" class="security-finding-dialog"><form id="securityFindingActionForm"><header><div><span id="securityFindingActionEyebrow">安全整改</span><h3 id="securityFindingActionTitle">登记复测结果</h3><p id="securityFindingActionDescription"></p></div><button type="button" id="closeSecurityFindingDialog" aria-label="关闭">×</button></header><section id="securityRetestFields"><label><span>独立复测证据</span><textarea id="securityRetestEvidence" maxlength="5000" placeholder="填写复测报告编号、复测结论或可核验的证据位置"></textarea></label><small>证据会写入安全整改记录，并进入下一份签名证据包。</small></section><section id="securityRiskFields" hidden><div class="security-risk-warning"><b>临时接受不会关闭风险</b><p>严重和高危风险仍会在上线就绪中心显示警告；到期后自动恢复为发布阻断。</p></div><label><span>业务接受原因</span><textarea id="securityRiskRationale" maxlength="2000" placeholder="说明暂时无法修复的原因、现有缓解措施和后续计划"></textarea></label><label><span>到期日期</span><input id="securityRiskExpiresAt" type="date"></label></section><p id="securityFindingActionError" class="security-finding-action-error" hidden></p><footer><button type="button" id="cancelSecurityFindingDialog">取消</button><button type="submit" id="submitSecurityFindingAction">保存整改记录</button></footer></form></dialog>`);
document.body.insertAdjacentHTML('beforeend', `<dialog id="actionConfirmDialog" class="action-confirm-dialog"><form id="actionConfirmForm"><header><span id="actionConfirmEyebrow">高影响操作</span><h3 id="actionConfirmTitle">确认操作</h3><p id="actionConfirmDescription"></p></header><label id="actionConfirmVerification" hidden><span id="actionConfirmVerificationLabel"></span><input id="actionConfirmInput" autocomplete="off"></label><footer><button type="button" id="cancelActionConfirm">取消</button><button type="submit" id="submitActionConfirm">确认</button></footer></form></dialog>`);
securityReviewedAt.value = new Date().toISOString().slice(0, 10);
operationsSection.insertAdjacentHTML('beforebegin', '<section id="githubIntegrationSection" class="github-integration-section"><div class="section-title"><div><b>GitHub 自动同步</b><small>接收 push 与 CI 事件，自动刷新代码证据</small></div><em id="githubIntegrationState">检查中…</em></div><div id="githubIntegrationEndpoint" class="github-integration-endpoint"></div><div id="githubDeliveryList" class="github-delivery-list"></div></section>');
githubIntegrationSection.insertAdjacentHTML('beforebegin', '<section id="deploymentConfigurationSection" class="deployment-configuration-section"><div class="section-title"><div><b>部署配置中心</b><small>只显示配置状态，不读取或展示任何秘密</small></div><button id="exportDeploymentConfiguration" type="button">下载运维清单</button></div><div id="deploymentConfigurationSummary" class="deployment-configuration-summary"><span>检查中…</span></div><div id="deploymentConfigurationList" class="deployment-configuration-list"></div><p id="deploymentConfigurationBoundary" class="deployment-configuration-boundary">配置由部署环境注入，本页面只读。</p></section>');
accountPanel.querySelector(':scope > header span').textContent = '设置与治理'; accountPanel.querySelector(':scope > header h2').textContent = '工作区设置';
accountPanel.querySelector(':scope > header').insertAdjacentHTML('afterend', '<nav class="account-settings-nav" aria-label="工作区设置分类"><button type="button" data-account-tab="team" class="active"><span>团队</span><small>成员与账户</small></button><button type="button" data-account-tab="gate"><span>上线门禁</span><small>风险与运行</small></button><button type="button" data-account-tab="integrations"><span>集成</span><small>代码与通知</small></button><button type="button" data-account-tab="governance"><span>治理</span><small>审计与保留</small></button></nav>');
const accountSettingsNav = accountPanel.querySelector('.account-settings-nav');
const accountGroupedSections = [
  [accountPanel.querySelector('.identity-section'), 'team'], [accountPanel.querySelector('.workspace-section'), 'team'], [accountPanel.querySelector('.member-section'), 'team'], [accountPanel.querySelector('.password-section'), 'team'],
  [readinessSection, 'gate'], [securityReviewSection, 'gate'], [operationsSection, 'gate'], [alertsSection, 'gate'],
  [deploymentConfigurationSection, 'integrations'], [githubIntegrationSection, 'integrations'], [automationSection, 'integrations'],
  [backupSection, 'governance'], [governanceSection, 'governance'], [auditSection, 'governance']
];
accountGroupedSections.forEach(([section, group]) => { section.dataset.accountGroup = group; section.dataset.accountAllowed = 'true'; });
let accountSettingsTab = 'team';
let currentMfaStatus = null;
let mfaDialogMode = null;
const renderAccountSettingsTab = () => {
  accountGroupedSections.forEach(([section, group]) => { section.hidden = group !== accountSettingsTab || section.dataset.accountAllowed !== 'true'; });
  accountSettingsNav.querySelectorAll('[data-account-tab]').forEach(button => { const available = accountGroupedSections.some(([section, group]) => group === button.dataset.accountTab && section.dataset.accountAllowed === 'true'); button.hidden = !available; button.classList.toggle('active', button.dataset.accountTab === accountSettingsTab); button.setAttribute('aria-current', button.dataset.accountTab === accountSettingsTab ? 'page' : 'false'); });
  accountSettingsNav.style.gridTemplateColumns = `repeat(${accountSettingsNav.querySelectorAll('[data-account-tab]:not([hidden])').length}, minmax(0, 1fr))`;
  const currentButton = accountSettingsNav.querySelector(`[data-account-tab="${accountSettingsTab}"]:not([hidden])`); if (!currentButton) { accountSettingsTab = 'team'; renderAccountSettingsTab(); }
};
accountSettingsNav.onclick = event => { const button = event.target.closest('[data-account-tab]'); if (!button || button.hidden) return; accountSettingsTab = button.dataset.accountTab; renderAccountSettingsTab(); accountPanel.scrollTo({ top: 0, behavior: 'smooth' }); };
exportDeploymentConfiguration.onclick = () => { if (!latestDeploymentConfiguration) return toast('配置清单尚未加载'); downloadJson(latestDeploymentConfiguration, `ShipWitness-deployment-${new Date().toISOString().slice(0, 10)}.json`); toast('脱敏运维清单已下载'); };
document.querySelector('.connect-form').insertAdjacentHTML('afterend', '<section class="repository-sync"><header><div><span>代码证据</span><b>GitHub 提交与 CI</b></div><button id="syncRepository" type="button">同步仓库</button></header><div id="repositoryStatus" class="repository-status"><p>保存 owner/repository 后，可以把验收任务固定到具体提交。</p></div></section>');
document.body.insertAdjacentHTML('beforeend', `<dialog id="starterDialog" class="starter-dialog"><form id="starterForm"><header><div><span>首次使用向导</span><h2>创建第一个真实验收</h2><p>选择场景并填写目标，系统会一次创建项目、可执行标准和首个验收任务。</p></div><button type="button" id="closeStarter" aria-label="关闭">×</button></header><section><div class="starter-step"><b>1</b><span>选择验收启动包</span></div><div id="starterKitList" class="starter-kit-list"></div></section><section><div class="starter-step"><b>2</b><span>连接你的测试项目</span></div><div class="starter-grid"><label><span>项目名称</span><input id="starterName" required placeholder="例如 客户管理后台"></label><label><span>代码分支</span><input id="starterBranch" value="main" required></label><label class="wide"><span>本机项目目录</span><input id="starterRepo" required placeholder="/Users/you/Projects/my-app"></label><label class="wide"><span>测试网址</span><input id="starterUrl" type="url" required placeholder="http://127.0.0.1:3000"></label><label><span>起始页面</span><input id="starterPath" value="/" required></label><label><span>页面必须出现的文字</span><input id="starterExpectedText" required placeholder="例如 登录 或产品名称"></label><label class="wide"><span>这次发布要证明什么</span><textarea id="starterRequirement" rows="2" required placeholder="用业务语言描述本次开发目标"></textarea></label></div></section><footer><label class="starter-execute"><input id="starterExecute" type="checkbox" checked><span>环境就绪后立即执行并保存截图证据</span></label><button type="submit" id="applyStarter">创建并开始验收</button></footer><p id="starterError" class="auth-error" hidden></p></form></dialog>`);
document.body.insertAdjacentHTML('beforeend', `<aside id="inboxPanel" class="inbox-panel" aria-hidden="true"><header><div><span>我的工作</span><h2>团队待办</h2><p>只展示当前工作区仍需要处理的事项。</p></div><button id="closeInbox" aria-label="关闭">×</button></header><div class="inbox-toolbar"><b id="inboxSummary">正在读取…</b><button id="readAllInbox">全部已读</button></div><section id="inboxList" class="inbox-list"><p>正在读取待办…</p></section></aside><div id="inboxMask" class="inbox-mask" hidden></div>`);
document.body.insertAdjacentHTML('beforeend', `<aside id="feedbackPanel" class="feedback-panel" aria-hidden="true"><header><div><span>受控试点</span><h2>反馈中心</h2><p>记录真实使用问题、建议和可用性反馈，并跟踪处理结论。</p></div><button id="closeFeedback" aria-label="关闭">×</button></header><form id="feedbackForm" class="feedback-form"><div><label><span>反馈类型</span><select id="feedbackKind"><option value="issue">问题</option><option value="usability">使用体验</option><option value="suggestion">功能建议</option></select></label><label><span>影响级别</span><select id="feedbackSeverity"><option value="medium">一般</option><option value="high">严重</option><option value="blocker">阻断使用</option><option value="low">轻微</option></select></label></div><label><span>关联项目</span><select id="feedbackProject"><option value="">工作区通用</option></select></label><label><span>一句话说明</span><input id="feedbackTitle" maxlength="200" required placeholder="例如：第一次创建验收时不知道下一步做什么"></label><label><span>具体情况</span><textarea id="feedbackDescription" maxlength="5000" rows="4" required placeholder="描述发生场景、预期结果，以及它怎样影响你的工作"></textarea></label><button>提交反馈</button></form><div class="feedback-toolbar"><div><b id="feedbackSummary">正在读取…</b><select id="feedbackFilter"><option value="">全部状态</option><option value="new">待分级</option><option value="triaged">已分级</option><option value="planned">已排期</option><option value="resolved">已解决</option><option value="declined">不处理</option></select></div><button id="exportFeedback" type="button">导出反馈</button></div><section id="feedbackList" class="feedback-list"><p>正在读取反馈…</p></section></aside><div id="feedbackMask" class="feedback-mask" hidden></div>`);
document.body.insertAdjacentHTML('beforeend', `<dialog id="feedbackActionDialog" class="feedback-action-dialog"><form id="feedbackActionForm"><header><div><span id="feedbackActionEyebrow">反馈处理</span><h3 id="feedbackActionTitle">更新处理状态</h3><p id="feedbackActionDescription"></p></div><button type="button" id="closeFeedbackAction" aria-label="关闭">×</button></header><section id="feedbackStatusFields"><label><span>处理状态</span><select id="feedbackActionStatus"><option value="new">待分级</option><option value="triaged">已分级</option><option value="planned">已排期</option><option value="resolved">已解决</option><option value="declined">不处理</option></select></label><label><span>处理说明</span><textarea id="feedbackActionNote" maxlength="1000" rows="4" placeholder="记录判断依据、计划或最终结论"></textarea></label><small>“已解决”和“不处理”必须填写结论，记录会进入审计链。</small></section><section id="feedbackPromoteFields" hidden><label><span>验收标准名称</span><input id="feedbackContractTitle" maxlength="500" required></label><label><span>正确结果</span><textarea id="feedbackExpectedResult" maxlength="5000" rows="5" placeholder="用可观察、可验证的业务结果描述修复后应达到什么状态"></textarea></label><small>将创建一个停用的标准草稿。补充浏览器步骤并启用后，才能进入新验收任务。</small></section><p id="feedbackActionError" class="feedback-action-error" hidden></p><footer><button type="button" id="cancelFeedbackAction">取消</button><button type="submit" id="submitFeedbackAction">保存</button></footer></form></dialog>`);
document.body.insertAdjacentHTML('beforeend', `<aside id="portfolioPanel" class="portfolio-panel" aria-hidden="true"><header><div><span>发布管理</span><h2>项目总览</h2><p>按真实验收证据汇总当前工作区，不使用 AI 猜测状态。</p></div><button id="closePortfolio" aria-label="关闭">×</button></header><section id="portfolioSummary" class="portfolio-summary"></section><div class="portfolio-toolbar"><div><b>使用中的项目</b><small id="portfolioUpdated">正在读取…</small></div><button id="portfolioAdd" type="button">＋ 接入项目</button></div><section id="portfolioList" class="portfolio-list"><p>正在汇总项目状态…</p></section><section id="portfolioArchiveSection" class="portfolio-archive-section" hidden><header><div><b>已归档项目</b><small>历史验收和证据仍然保留</small></div><span id="portfolioArchiveCount">0</span></header><div id="portfolioArchived" class="portfolio-archived"></div></section></aside><div id="portfolioMask" class="portfolio-mask" hidden></div><dialog id="archiveProjectDialog" class="archive-project-dialog"><form id="archiveProjectForm"><header><div><span>项目生命周期</span><h3>归档项目</h3></div><button type="button" id="closeArchiveProject">×</button></header><p>归档后项目会离开日常工作区，但历史验收、证据和审计记录都会保留，也可以随时恢复。</p><input type="hidden" id="archiveProjectId"><label><span>归档原因</span><textarea id="archiveProjectReason" rows="3" maxlength="1000" required placeholder="例如：项目已交付，暂不再维护"></textarea></label><div id="archiveProjectError" class="archive-project-error" hidden></div><footer><button type="button" id="cancelArchiveProject">取消</button><button type="submit">确认归档</button></footer></form></dialog>`);
let authMode = 'login';
let currentSession = null;
let invitationToken = null;
let invitationDetails = null;
let mfaChallengeToken = null;
let mfaInvitationActive = false;
let passwordResetToken = null;
let setupWizardStep = 1;
let setupStatusDetails = null;
const renderSetupWizard = () => {
  const profile = setupStatusDetails || { checks: [], deploymentMode: 'controlled_pilot' }; const accountStep = setupWizardStep === 2;
  setupOverview.hidden = false; setupOverview.querySelectorAll('.setup-progress span').forEach((item, index) => item.classList.toggle('active', index + 1 === setupWizardStep));
  setupCheckList.hidden = accountStep; setupBoundary.hidden = accountStep;
  setupCheckList.innerHTML = profile.checks.map(item => `<article class="${item.status}"><i>${item.status === 'pass' ? '✓' : '!'}</i><div><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.detail)}</small></div></article>`).join('');
  setupBoundary.textContent = profile.deploymentMode === 'public_candidate' ? '当前配置具备 HTTPS 公网候选基础；完成初始化后仍需在“上线就绪中心”通过全部门禁。' : '当前配置适合本地或受控试点，不代表已经达到公网正式上线条件。';
  workspaceField.hidden = !accountStep; nameField.hidden = !accountStep; emailField.hidden = !accountStep; passwordField.hidden = !accountStep;
  authWorkspace.required = accountStep; authName.required = accountStep; authEmail.required = accountStep; authPassword.required = accountStep;
  authTitle.textContent = accountStep ? '创建首位管理员' : '检查部署条件'; authDescription.textContent = accountStep ? '管理员负责成员权限、发布审批和安全治理。请使用长期有效的工作邮箱。' : '先确认数据、安全和通知能力，再建立你的组织空间。'; authSubmit.textContent = accountStep ? '完成初始化并进入' : '继续创建管理员';
};
const showAuth = (mode, details = null) => {
  authMode = mode; bootGate.hidden = true; authGate.hidden = false; document.body.classList.remove('auth-pending'); document.body.classList.add('auth-locked');
  setupOverview.hidden = true;
  const setup = mode === 'setup'; workspaceField.hidden = !setup; nameField.hidden = !setup; emailField.hidden = false; passwordField.hidden = false; resetConfirmField.hidden = true; mfaCodeField.hidden = true; authMfaCode.required = false; authPasswordConfirm.required = false; authEmail.required = true; authPassword.required = true; authName.required = setup; forgotPassword.hidden = setup; forgotPassword.textContent = '忘记密码'; passwordField.querySelector('span').textContent = '密码';
  authTitle.textContent = setup ? '创建第一个安全工作区' : '登录 ShipWitness';
  authEyebrow.textContent = setup ? '首次初始化' : '安全工作区';
  authDescription.textContent = setup ? '创建本机管理员。现有项目数据会安全归入这个工作区。' : '验收证据、返工单和发布决定只对工作区成员可见。';
  authSubmit.textContent = setup ? '创建并进入工作区' : '登录';
  authPassword.autocomplete = setup ? 'new-password' : 'current-password';
  if (setup) { setupStatusDetails = details; setupWizardStep = 1; renderSetupWizard(); }
};
const showInvitation = (details, token) => {
  invitationToken = token; invitationDetails = details; authMode = 'invite'; authGate.hidden = false; document.body.classList.add('auth-locked');
  workspaceField.hidden = true; emailField.hidden = true; authEmail.required = false; nameField.hidden = details.existingAccount; authName.required = !details.existingAccount;
  authName.value = ''; authEmail.value = ''; forgotPassword.hidden = true; resetConfirmField.hidden = true;
  authEyebrow.textContent = '工作区邀请'; authTitle.textContent = `加入 ${details.workspace.name}`;
  authDescription.textContent = details.existingAccount ? `邀请发送给 ${details.maskedEmail}。请输入现有账号密码确认身份。` : `邀请发送给 ${details.maskedEmail}。请设置姓名和自己的登录密码。`;
  authSubmit.textContent = '接受邀请并进入'; authPassword.autocomplete = details.existingAccount ? 'current-password' : 'new-password'; authPassword.value = '';
};
const showMfaChallenge = challengeToken => { mfaInvitationActive = authMode === 'invite'; mfaChallengeToken = challengeToken; authMode = 'mfa'; workspaceField.hidden = true; nameField.hidden = true; emailField.hidden = true; passwordField.hidden = true; resetConfirmField.hidden = true; mfaCodeField.hidden = false; forgotPassword.hidden = true; authMfaCode.required = true; authMfaCode.value = ''; authEyebrow.textContent = '两步验证'; authTitle.textContent = '确认是你本人'; authDescription.textContent = '输入验证器生成的 6 位动态验证码，或使用一条尚未用过的恢复码。'; authSubmit.textContent = '验证并进入'; authMfaCode.focus(); };
const showPasswordReset = (details, token) => { passwordResetToken = token; authMode = 'passwordReset'; authGate.hidden = false; document.body.classList.add('auth-locked'); workspaceField.hidden = true; nameField.hidden = true; emailField.hidden = true; passwordField.hidden = false; passwordField.querySelector('span').textContent = '新密码'; authPassword.value = ''; authPassword.autocomplete = 'new-password'; resetConfirmField.hidden = false; authPasswordConfirm.required = true; authPasswordConfirm.value = ''; mfaCodeField.hidden = true; forgotPassword.hidden = true; authEyebrow.textContent = '账户恢复'; authTitle.textContent = '设置新密码'; authDescription.textContent = `正在为 ${details.maskedEmail} 重置密码。保存后所有旧设备立即退出${details.mfaEnabled ? '，两步验证继续保留' : ''}。`; authSubmit.textContent = '保存新密码'; };
forgotPassword.onclick = () => { if (authMode === 'passwordResetRequest') return showAuth('login'); authMode = 'passwordResetRequest'; workspaceField.hidden = true; nameField.hidden = true; passwordField.hidden = true; resetConfirmField.hidden = true; mfaCodeField.hidden = true; emailField.hidden = false; authEmail.required = true; authEyebrow.textContent = '账户恢复'; authTitle.textContent = '找回密码'; authDescription.textContent = '输入登录邮箱。如果账号存在且部署已配置邮件服务，你会收到一条 30 分钟有效的一次性链接。'; authSubmit.textContent = '发送重置链接'; forgotPassword.textContent = '返回登录'; };
const hideAuth = session => { currentSession = session; bootGate.hidden = true; authGate.hidden = true; document.body.classList.remove('auth-pending', 'auth-locked'); accountBtn.textContent = `${session.workspace.name} · ${session.user.name}`; };

const renderProjectMenu = () => {
  projectSwitchBtn.querySelector('b').textContent = backendProject?.name || '尚未接入';
  projectMenu.innerHTML = `<header><span>当前工作区项目</span><small>${backendProjects.length} 个</small></header><div>${backendProjects.map(item => `<button type="button" data-project-id="${item.id}" class="${item.id === backendProjectId ? 'selected' : ''}"><i>${item.id === backendProjectId ? '✓' : ''}</i><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.branch)} · ${escapeHtml(new URL(item.url).host)}</small></span></button>`).join('') || '<p>还没有接入项目</p>'}</div><button type="button" class="project-add" id="projectAddBtn"><span>＋</span> 接入新项目</button>`;
  projectMenu.querySelectorAll('[data-project-id]').forEach(button => { button.onclick = async () => {
    if (button.dataset.projectId === backendProjectId) { projectMenu.hidden = true; projectSwitchBtn.setAttribute('aria-expanded', 'false'); return; }
    button.disabled = true;
    try { await api(`/api/projects/${button.dataset.projectId}/select`, { method: 'POST' }); projectMenu.hidden = true; projectSwitchBtn.setAttribute('aria-expanded', 'false'); dashboardCriterionIndex = 0; dashboardStage = 'claim'; await bootstrapBackend(); toast('已切换项目'); }
    catch (error) { toast(error.message); button.disabled = false; }
  }; });
  projectMenu.querySelector('#projectAddBtn').onclick = () => { projectMenu.hidden = true; projectSwitchBtn.setAttribute('aria-expanded', 'false'); openStarter({ additional: true }).catch(error => toast(error.message)); };
};

projectSwitchBtn.onclick = event => { event.stopPropagation(); projectMenu.hidden = !projectMenu.hidden; projectSwitchBtn.setAttribute('aria-expanded', String(!projectMenu.hidden)); };
projectMenu.onclick = event => event.stopPropagation();
document.addEventListener('click', () => { projectMenu.hidden = true; projectSwitchBtn.setAttribute('aria-expanded', 'false'); });

const portfolioState = state => ({ approved: ['已批准发布', 'success'], awaiting_approval: ['等待审批', 'review'], failed: ['验收失败', 'danger'], held: ['暂不发布', 'danger'], running: ['正在验收', 'active'], queued: ['等待执行', 'active'], evidence_insufficient: ['证据不足', 'warning'], not_started: ['尚未开始', 'muted'] }[state] || ['状态未知', 'muted']);
const togglePortfolio = open => { portfolioPanel.classList.toggle('open', open); portfolioPanel.setAttribute('aria-hidden', String(!open)); portfolioMask.hidden = !open; };
async function loadPortfolio() {
  const overview = await api('/api/projects/overview');
  portfolioSummary.innerHTML = `<article><b>${overview.summary.projects}</b><span>使用中</span></article><article class="attention"><b>${overview.summary.actionable}</b><span>需要处理</span></article><article><b>${overview.summary.inProgress}</b><span>进行中</span></article><article class="success"><b>${overview.summary.approved}</b><span>已批准</span></article><article><b>${overview.summary.archived}</b><span>已归档</span></article>`;
  portfolioUpdated.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  portfolioList.innerHTML = overview.items.map(item => { const [label, tone] = portfolioState(item.state); return `<article class="portfolio-card ${tone}" data-project-card="${item.id}"><header><div><span>${escapeHtml(item.branch)}</span><h3>${escapeHtml(item.name)}</h3></div><em>${label}</em></header><p>${item.latestRun ? escapeHtml(item.latestRun.requirement) : '还没有创建验收任务'}</p><div class="portfolio-metrics"><span><b>${item.counts.runs}</b> 验收</span><span><b>${item.counts.enabledContracts}</b> 标准</span><span class="${item.counts.openIssues ? 'has-issues' : ''}"><b>${item.counts.openIssues}</b> 待返工</span></div><footer><small>${new Date(item.updatedAt).toLocaleString('zh-CN')}</small><div>${currentSession?.role === 'owner' ? `<button type="button" class="archive-action" data-archive-project="${item.id}" data-project-name="${escapeHtml(item.name)}">归档</button>` : ''}<button type="button" data-open-project="${item.id}">进入项目</button>${item.latestRun ? `<button type="button" class="primary" data-open-portfolio-run="${item.latestRun.id}" data-project-id="${item.id}">查看任务</button>` : ''}</div></footer></article>`; }).join('') || '<div class="portfolio-empty"><b>还没有使用中的项目</b><p>接入新项目或从下方恢复已归档项目。</p></div>';
  portfolioArchiveSection.hidden = !overview.archived.length; portfolioArchiveCount.textContent = overview.archived.length;
  portfolioArchived.innerHTML = overview.archived.map(item => `<article><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.archiveReason)} · ${new Date(item.archivedAt).toLocaleString('zh-CN')}</small></div><span>${item.counts.runs} 次验收 · ${item.counts.contracts} 条标准</span>${currentSession?.role === 'owner' ? `<button type="button" data-restore-project="${item.id}">恢复项目</button>` : ''}</article>`).join('');
  portfolioList.querySelectorAll('[data-open-project]').forEach(button => { button.onclick = async () => { await api(`/api/projects/${button.dataset.openProject}/select`, { method: 'POST' }); togglePortfolio(false); await bootstrapBackend(); toast('已进入项目'); }; });
  portfolioList.querySelectorAll('[data-open-portfolio-run]').forEach(button => { button.onclick = async () => { await api(`/api/projects/${button.dataset.projectId}/select`, { method: 'POST' }); togglePortfolio(false); history.replaceState({}, '', `?run=${encodeURIComponent(button.dataset.openPortfolioRun)}`); await bootstrapBackend(); }; });
  portfolioList.querySelectorAll('[data-archive-project]').forEach(button => { button.onclick = () => { archiveProjectId.value = button.dataset.archiveProject; archiveProjectReason.value = ''; archiveProjectError.hidden = true; archiveProjectDialog.querySelector('h3').textContent = `归档“${button.dataset.projectName}”`; archiveProjectDialog.showModal(); }; });
  portfolioArchived.querySelectorAll('[data-restore-project]').forEach(button => { button.onclick = async () => { button.disabled = true; try { await api(`/api/projects/${button.dataset.restoreProject}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: false }) }); await loadPortfolio(); await bootstrapBackend(); toast('项目已恢复'); } catch (error) { toast(error.message); button.disabled = false; } }; });
}
portfolioBtn.onclick = async () => { togglePortfolio(true); try { await loadPortfolio(); } catch (error) { portfolioList.innerHTML = `<p class="portfolio-error">${escapeHtml(error.message)}</p>`; } };
closePortfolio.onclick = () => togglePortfolio(false); portfolioMask.onclick = () => togglePortfolio(false);
portfolioAdd.onclick = () => { togglePortfolio(false); openStarter({ additional: true }).catch(error => toast(error.message)); };
closeArchiveProject.onclick = cancelArchiveProject.onclick = () => archiveProjectDialog.close();
archiveProjectForm.onsubmit = async event => { event.preventDefault(); const submit = archiveProjectForm.querySelector('button[type="submit"]'); submit.disabled = true; archiveProjectError.hidden = true; try { await api(`/api/projects/${archiveProjectId.value}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: true, reason: archiveProjectReason.value }) }); archiveProjectDialog.close(); await loadPortfolio(); await bootstrapBackend(); toast('项目已归档，历史证据仍然保留'); } catch (error) { archiveProjectError.textContent = error.message; archiveProjectError.hidden = false; } finally { submit.disabled = false; } };

authForm.onsubmit = async event => {
  event.preventDefault(); authSubmit.disabled = true; authError.hidden = true;
  try {
    if (authMode === 'setup' && setupWizardStep === 1) { setupWizardStep = 2; renderSetupWizard(); authWorkspace.focus(); return; }
    if (authMode === 'passwordReset' && authPassword.value !== authPasswordConfirm.value) throw new Error('两次输入的新密码不一致');
    const path = authMode === 'setup' ? '/api/setup' : authMode === 'invite' ? `/api/invitations/${invitationToken}` : authMode === 'mfa' ? '/api/login/mfa' : authMode === 'passwordResetRequest' ? '/api/password-reset/request' : authMode === 'passwordReset' ? `/api/password-reset/${passwordResetToken}` : '/api/login';
    const payload = authMode === 'mfa' ? { challengeToken: mfaChallengeToken, code: authMfaCode.value } : authMode === 'passwordResetRequest' ? { email: authEmail.value } : authMode === 'passwordReset' ? { newPassword: authPassword.value } : authMode === 'invite' ? { password: authPassword.value, ...(!invitationDetails.existingAccount ? { name: authName.value } : {}) } : { email: authEmail.value, password: authPassword.value, ...(authMode === 'setup' ? { workspaceName: authWorkspace.value, name: authName.value } : {}) };
    const session = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    if (authMode === 'passwordResetRequest') { authDescription.textContent = session.message; authSubmit.textContent = '重新发送'; toast('请求已受理'); return; }
    if (authMode === 'passwordReset') { history.replaceState({}, '', location.pathname); showAuth('login'); authPassword.value = ''; toast('密码已更新，请重新登录'); return; }
    if (session.mfaRequired) return showMfaChallenge(session.challengeToken);
    if (authMode === 'invite' || mfaInvitationActive) { history.replaceState({}, '', location.pathname); mfaInvitationActive = false; }
    hideAuth(session); await bootstrapBackend(); if (session.user.mustChangePassword) { await loadAccountPanel(); toast('请先修改管理员发放的临时密码'); }
  } catch (error) { authError.textContent = error.message; authError.hidden = false; }
  finally { authSubmit.disabled = false; }
};
logoutBtn.onclick = async () => { try { await api('/api/logout', { method: 'POST' }); location.reload(); } catch (error) { toast(error.message); } };
const roleLabel = role => ({ owner: '管理员', approver: '审批人', member: '成员' }[role] || role);
const toggleAccount = open => { accountPanel.classList.toggle('open', open); accountPanel.setAttribute('aria-hidden', String(!open)); accountMask.hidden = !open; };
const inboxTypeLabel = type => ({ execution: '等待执行', recovery: '需要接管', failure: '验收失败', approval: '等待审批', retest: '等待复验', delivery: '投递失败', feedback: '试点反馈' }[type] || '待处理');
const toggleInbox = open => { inboxPanel.classList.toggle('open', open); inboxPanel.setAttribute('aria-hidden', String(!open)); inboxMask.hidden = !open; };
const toggleFeedback = open => { feedbackPanel.classList.toggle('open', open); feedbackPanel.setAttribute('aria-hidden', String(!open)); feedbackMask.hidden = !open; };
const feedbackKindLabel = value => ({ issue: '问题', suggestion: '功能建议', usability: '使用体验' }[value] || value);
const feedbackSeverityLabel = value => ({ low: '轻微', medium: '一般', high: '严重', blocker: '阻断使用' }[value] || value);
const feedbackStatusLabel = value => ({ new: '待分级', triaged: '已分级', planned: '已排期', resolved: '已解决', declined: '不处理' }[value] || value);
async function loadFeedback({ open = false, focusId = null } = {}) {
  const [items, projects] = await Promise.all([api(`/api/feedback${feedbackFilter.value ? `?status=${encodeURIComponent(feedbackFilter.value)}` : ''}`), api('/api/projects')]);
  const canManage = ['owner', 'approver'].includes(currentSession?.role);
  feedbackProject.innerHTML = '<option value="">工作区通用</option>' + projects.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  feedbackSummary.textContent = items.length ? `${items.length} 条反馈${items.filter(item => item.status === 'new').length ? ` · ${items.filter(item => item.status === 'new').length} 条待分级` : ''}` : '还没有反馈'; exportFeedback.hidden = !canManage;
  feedbackList.innerHTML = items.map(item => `<article class="feedback-card ${item.severity} ${item.id === focusId ? 'focused' : ''}" data-feedback-id="${item.id}"><header><div><span>${feedbackKindLabel(item.kind)} · ${feedbackSeverityLabel(item.severity)}</span><h3>${escapeHtml(item.title)}</h3></div><div class="feedback-card-actions"><em>${feedbackStatusLabel(item.status)}</em>${canManage ? `${['resolved', 'declined'].includes(item.status) ? `<button data-reopen-feedback="${item.id}" data-feedback-status-value="${item.linkedContractId ? 'planned' : 'triaged'}" data-feedback-title="${escapeHtml(item.title)}">重新打开</button>` : `<button data-manage-feedback="${item.id}" data-feedback-status-value="${item.status}" data-feedback-title="${escapeHtml(item.title)}">处理</button>`}${item.project && !item.linkedContractId && !['resolved', 'declined'].includes(item.status) ? `<button data-promote-feedback="${item.id}" data-feedback-title="${escapeHtml(item.title)}">转为标准</button>` : ''}${item.linkedContractId ? `<button data-open-feedback-contract="${item.linkedContractId}" data-project-id="${item.projectId}">查看标准</button>` : ''}` : ''}</div></header><p>${escapeHtml(item.description)}</p>${item.verification ? `<div class="feedback-verification"><div><b>✓ 已由验收证据确认解决</b><span>标准 V${item.verification.contractVersion} · ${new Date(item.verification.verifiedAt).toLocaleString('zh-CN')}${item.verificationHistory?.length ? ` · 历史验证 ${item.verificationHistory.length} 次` : ''}</span></div><button data-open-feedback-run="${item.verification.runId}" data-project-id="${item.projectId}">查看验证任务</button></div>` : ''}<footer><span>${escapeHtml(item.project?.name || '工作区通用')} · ${escapeHtml(item.reporter?.name || '未知成员')}</span><time>${new Date(item.createdAt).toLocaleString('zh-CN')}</time></footer></article>`).join('') || '<p class="feedback-empty">当前筛选条件下没有反馈。</p>';
  if (open) toggleFeedback(true); if (focusId) feedbackList.querySelector(`[data-feedback-id="${focusId}"]`)?.scrollIntoView({ block: 'center' });
}
feedbackBtn.onclick = () => loadFeedback({ open: true }).catch(error => toast(error.message)); closeFeedback.onclick = () => toggleFeedback(false); feedbackMask.onclick = () => toggleFeedback(false);
feedbackFilter.onchange = () => loadFeedback().catch(error => toast(error.message));
feedbackForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ kind: feedbackKind.value, severity: feedbackSeverity.value, projectId: feedbackProject.value || null, title: feedbackTitle.value, description: feedbackDescription.value }) }); feedbackTitle.value = ''; feedbackDescription.value = ''; await loadFeedback(); await loadInbox(); toast('反馈已提交并进入处理队列'); } catch (error) { toast(error.message); } };
const closeFeedbackActionDialog = () => { pendingFeedbackAction = null; feedbackActionStatus.disabled = false; feedbackActionNote.required = false; feedbackContractTitle.required = false; feedbackExpectedResult.required = false; feedbackActionDialog.close(); };
closeFeedbackAction.onclick = closeFeedbackActionDialog; cancelFeedbackAction.onclick = closeFeedbackActionDialog;
feedbackList.onclick = async event => {
  const manage = event.target.closest('[data-manage-feedback]'); const promote = event.target.closest('[data-promote-feedback]'); const reopen = event.target.closest('[data-reopen-feedback]'); const openContract = event.target.closest('[data-open-feedback-contract]'); const openRun = event.target.closest('[data-open-feedback-run]');
  if (openContract || openRun) { try { const target = openContract || openRun; await api(`/api/projects/${target.dataset.projectId}/select`, { method: 'POST' }); toggleFeedback(false); await bootstrapBackend(); if (openContract) contractsBtn.click(); else { backendRunId = openRun.dataset.openFeedbackRun; history.replaceState({}, '', `?run=${encodeURIComponent(backendRunId)}`); await loadRunTask(); } } catch (error) { toast(error.message); } return; }
  if (!manage && !promote && !reopen) return;
  const trigger = promote || reopen || manage; pendingFeedbackAction = { mode: promote ? 'promote' : reopen ? 'reopen' : 'status', id: promote?.dataset.promoteFeedback || reopen?.dataset.reopenFeedback || manage?.dataset.manageFeedback };
  feedbackActionError.hidden = true; feedbackStatusFields.hidden = Boolean(promote); feedbackPromoteFields.hidden = !promote;
  feedbackActionEyebrow.textContent = promote ? '反馈转化' : reopen ? '回归处理' : '反馈处理'; feedbackActionTitle.textContent = promote ? '创建验收标准草稿' : reopen ? '重新打开反馈' : '更新处理状态'; feedbackActionDescription.textContent = trigger.dataset.feedbackTitle;
  if (promote) { feedbackContractTitle.value = `反馈验收：${promote.dataset.feedbackTitle}`; feedbackExpectedResult.value = ''; feedbackContractTitle.required = true; feedbackExpectedResult.required = true; }
  else { feedbackActionStatus.value = trigger.dataset.feedbackStatusValue; feedbackActionStatus.disabled = Boolean(reopen); feedbackActionNote.value = ''; feedbackActionNote.required = Boolean(reopen); feedbackActionNote.placeholder = reopen ? '说明重新出现的场景、影响和需要复验的原因' : '记录判断依据、计划或最终结论'; feedbackContractTitle.required = false; feedbackExpectedResult.required = false; }
  submitFeedbackAction.textContent = promote ? '创建标准草稿' : reopen ? '确认重新打开' : '保存处理记录'; feedbackActionDialog.showModal();
};
feedbackActionForm.onsubmit = async event => { event.preventDefault(); if (!pendingFeedbackAction) return; submitFeedbackAction.disabled = true; feedbackActionError.hidden = true; try { if (pendingFeedbackAction.mode === 'promote') { await api(`/api/feedback/${pendingFeedbackAction.id}/promote`, { method: 'POST', body: JSON.stringify({ title: feedbackContractTitle.value, expectedResult: feedbackExpectedResult.value }) }); toast('验收标准草稿已创建，请补充步骤后启用'); } else if (pendingFeedbackAction.mode === 'reopen') { await api(`/api/feedback/${pendingFeedbackAction.id}/reopen`, { method: 'POST', body: JSON.stringify({ reason: feedbackActionNote.value }) }); toast('反馈已重新打开，历史验证证据继续保留'); } else { await api(`/api/feedback/${pendingFeedbackAction.id}`, { method: 'PATCH', body: JSON.stringify({ status: feedbackActionStatus.value, note: feedbackActionNote.value }) }); toast('反馈处理记录已保存'); } closeFeedbackActionDialog(); await loadFeedback(); await loadInbox(); } catch (error) { feedbackActionError.textContent = error.message; feedbackActionError.hidden = false; } finally { submitFeedbackAction.disabled = false; feedbackActionStatus.disabled = false; feedbackActionNote.required = false; } };
exportFeedback.onclick = async () => { try { const document = await api('/api/feedback/export'); downloadJson(document, `ShipWitness-feedback-${new Date().toISOString().slice(0, 10)}.json`); toast('试点反馈已导出'); } catch (error) { toast(error.message); } };
async function loadInbox({ open = false } = {}) {
  const inbox = await api('/api/inbox');
  inboxBadge.hidden = !inbox.unreadCount; inboxBadge.textContent = String(inbox.unreadCount);
  inboxSummary.textContent = inbox.total ? `${inbox.total} 项待处理 · ${inbox.unreadCount} 项未读` : '当前没有待处理事项'; readAllInbox.hidden = !inbox.unreadCount;
  inboxList.innerHTML = inbox.items.map(item => `<article class="${item.unread ? 'unread' : ''} ${item.priority === 'high' ? 'high' : ''}" data-inbox-key="${escapeHtml(item.key)}" data-action-kind="${item.action.kind}" data-action-id="${item.action.id}"><i></i><div><span>${inboxTypeLabel(item.type)}</span><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.detail)}</p><small>${new Date(item.createdAt).toLocaleString('zh-CN')}</small></div><button>处理 →</button></article>`).join('') || '<p class="inbox-empty">很好，当前没有等待你处理的事项。</p>';
  if (open) toggleInbox(true);
  return inbox;
}
inboxBtn.onclick = () => loadInbox({ open: true }).catch(error => toast(error.message)); closeInbox.onclick = () => toggleInbox(false); inboxMask.onclick = () => toggleInbox(false);
readAllInbox.onclick = async () => { try { await api('/api/inbox/read', { method: 'POST', body: JSON.stringify({ all: true }) }); await loadInbox({ open: true }); } catch (error) { toast(error.message); } };
inboxList.onclick = async event => {
  const item = event.target.closest('[data-inbox-key]'); if (!item) return;
  try {
    await api('/api/inbox/read', { method: 'POST', body: JSON.stringify({ keys: [item.dataset.inboxKey] }) }); toggleInbox(false);
    if (item.dataset.actionKind === 'run') { backendRunId = item.dataset.actionId; await loadRunTask(); }
    else if (item.dataset.actionKind === 'feedback') await loadFeedback({ open: true, focusId: item.dataset.actionId });
    else await loadAccountPanel();
    await loadInbox();
  } catch (error) { toast(error.message); }
};
async function loadAccountPanel() {
  const canAudit = ['owner', 'approver'].includes(currentSession?.role);
  const isOwner = currentSession?.role === 'owner';
  const alerts = canAudit ? await api('/api/alerts/refresh', { method: 'POST' }) : [];
  const [workspaces, members, audit, integrity, apiKeys, webhooks, operations, retention, auditExports, invitations, emailStatus, emailDeliveries, readiness, githubIntegration, securityReviews, sessions, mfaStatus, backups, deploymentConfiguration, acceptanceSecrets] = await Promise.all([api('/api/workspaces'), api('/api/members'), canAudit ? api('/api/audit?limit=30') : [], canAudit ? api('/api/audit/verify') : null, isOwner ? api('/api/api-keys') : [], isOwner ? api('/api/webhooks') : [], canAudit ? api('/api/system/status') : null, isOwner ? api('/api/retention') : null, canAudit ? api('/api/audit-exports') : [], isOwner ? api('/api/invitations') : [], isOwner ? api('/api/email/status') : null, isOwner ? api('/api/email-deliveries') : [], isOwner ? api('/api/readiness') : null, canAudit ? api('/api/integrations/github') : null, canAudit ? api('/api/security/reviews') : [], api('/api/account/sessions'), api('/api/account/mfa'), isOwner ? api('/api/backups') : null, isOwner ? api('/api/deployment/configuration') : null, isOwner ? api('/api/acceptance-secrets') : []]);
  workspaceList.innerHTML = workspaces.map(item => `<button data-workspace-id="${item.id}" ${item.current ? 'disabled' : ''}><span><b>${escapeHtml(item.name)}</b><small>${item.current ? '当前工作区' : '点击切换'}</small></span><em>${item.current ? '当前' : '切换'}</em></button>`).join('');
  profileName.value = currentSession.user.name; profileEmail.value = currentSession.user.email; workspaceIdentityName.value = currentSession.workspace.name; workspaceIdentityForm.hidden = !isOwner;
  memberList.innerHTML = members.map(item => `<article class="${item.disabledAt ? 'member-disabled' : ''}"><span>${escapeHtml(item.name).slice(0, 1).toUpperCase()}</span><div><b>${escapeHtml(item.name)}${item.id === currentSession.user.id ? ' · 我' : ''}${item.disabledAt ? ' · 已停用' : ''}</b><small>${escapeHtml(item.email)}${item.mustChangePassword ? ' · 待改密' : ''} · ${item.activeSessions} 台在线设备${item.mfaEnabled ? ' · MFA 已启用' : ''}</small></div>${isOwner ? `<select data-member-role="${item.membershipId}" ${item.disabledAt ? 'disabled' : ''}><option value="member" ${item.role === 'member' ? 'selected' : ''}>成员</option><option value="approver" ${item.role === 'approver' ? 'selected' : ''}>审批人</option><option value="owner" ${item.role === 'owner' ? 'selected' : ''}>管理员</option></select><div class="member-actions">${item.id === currentSession.user.id ? '' : `<button data-member-access="${item.membershipId}" data-member-action="${item.disabledAt ? 'enable' : 'disable'}" data-member-name="${escapeHtml(item.name)}">${item.disabledAt ? '启用' : '停用'}</button>${item.activeSessions ? `<button data-revoke-member-sessions="${item.membershipId}" data-member-name="${escapeHtml(item.name)}">强制下线</button>` : ''}${item.mfaEnabled ? `<button data-reset-member-mfa="${item.membershipId}" data-member-name="${escapeHtml(item.name)}">重置 MFA</button>` : ''}<button data-reset-member="${item.membershipId}" data-member-name="${escapeHtml(item.name)}">重置密码</button>`}<button data-remove-member="${item.membershipId}" aria-label="移除 ${escapeHtml(item.name)}">移除</button></div>` : `<em>${roleLabel(item.role)}</em>`}</article>`).join('');
  invitationList.hidden = !isOwner; invitationList.innerHTML = isOwner ? invitations.slice(0, 8).map(item => `<article><div><b>${escapeHtml(item.email)}</b><small>${roleLabel(item.role)} · ${item.status === 'pending' ? `等待接受，${new Date(item.expiresAt).toLocaleString('zh-CN')} 到期` : item.status === 'accepted' ? '已接受' : item.status === 'expired' ? '已过期' : '已撤销'}</small></div>${item.status === 'pending' ? `<button data-revoke-invitation="${item.id}">撤销</button>` : `<em>${item.status === 'accepted' ? '完成' : '失效'}</em>`}</article>`).join('') : '';
  memberForm.hidden = currentSession?.role !== 'owner';
  automationSection.dataset.accountAllowed = String(isOwner);
  governanceSection.dataset.accountAllowed = String(canAudit);
  backupSection.dataset.accountAllowed = String(isOwner);
  if (isOwner) { createBackup.disabled = !backups.available; backupState.textContent = backups.available ? backups.verifiedBackupAt ? `最近校验：${new Date(backups.verifiedBackupAt).toLocaleString('zh-CN')}` : '尚无已验证备份' : backups.reason; backupList.innerHTML = backups.items.map(item => `<article><div><b>${new Date(item.createdAt).toLocaleString('zh-CN')}</b><small>${escapeHtml(item.applicationVersion || '版本未知')} · Schema ${item.schemaVersion ?? '—'} · ${item.evidenceFiles} 个证据文件</small></div><div><button data-verify-backup="${item.id}">校验</button><button data-preflight-backup="${item.id}">恢复预检</button>${backups.drillAvailable ? `<button data-drill-backup="${item.id}">执行演练</button>` : ''}</div></article>`).join('') || '<p>还没有备份恢复点。</p>'; recoveryDrillState.textContent = backups.drillAvailable ? '隔离演练数据库已配置' : '未配置隔离演练数据库'; recoveryDrillList.innerHTML = backups.drills.map(item => `<article><i>✓</i><div><b>${new Date(item.completedAt).toLocaleString('zh-CN')}</b><small>${escapeHtml(item.backupId)} · ${item.counts.runs} 个任务 · ${item.durationMs} ms</small></div><em>恢复通过</em></article>`).join('') || '<p>尚无真实恢复演练记录。</p>'; }
  retentionForm.hidden = !isOwner; previewRetention.hidden = !isOwner;
  if (isOwner) operationalDays.value = String(retention.operationalDays);
  const latestExport = auditExports[0];
  auditExportSummary.textContent = latestExport ? `${latestExport.eventCount} 条事件 · ${new Date(latestExport.createdAt).toLocaleString('zh-CN')}` : '尚未生成导出';
  downloadAuditExport.hidden = !latestExport; if (latestExport) downloadAuditExport.href = latestExport.downloadUrl;
  operationsSection.dataset.accountAllowed = String(canAudit);
  alertsSection.dataset.accountAllowed = String(canAudit);
  readinessSection.dataset.accountAllowed = String(isOwner);
  securityReviewSection.dataset.accountAllowed = String(canAudit); securityReviewForm.hidden = !isOwner;
  githubIntegrationSection.dataset.accountAllowed = String(canAudit);
  deploymentConfigurationSection.dataset.accountAllowed = String(isOwner);
  if (isOwner) {
    acceptanceSecretList.innerHTML = acceptanceSecrets.map(item => `<article class="secret-${item.status}"><div><b>${escapeHtml(item.name)}${item.status === 'expired' ? ' · 已过期' : item.status === 'expiring' ? ' · 即将到期' : ''}</b><small>${item.daysRemaining == null ? '未设置期限' : item.status === 'expired' ? '必须轮换后才能执行' : `剩余 ${item.daysRemaining} 天`} · ${item.referenceCount ? `${item.referenceCount} 条启用标准引用` : '暂无启用引用'}</small></div><div><button data-rotate-acceptance-secret="${item.id}" data-secret-name="${escapeHtml(item.name)}">轮换</button><button data-delete-acceptance-secret="${item.id}" ${item.referenceCount ? 'disabled title="仍被启用标准引用"' : ''}>删除</button></div></article>`).join('') || '<p>尚未保存验收凭据</p>';
    acceptanceSecretRefs.innerHTML = acceptanceSecrets.map(item => `<option value="{{secret:${escapeHtml(item.name)}}}">`).join('');
    latestDeploymentConfiguration = deploymentConfiguration; const verdictLabels = { incomplete: '配置不完整', attention: '可试点，仍需完善', ready: '交付配置已就绪' };
    deploymentConfigurationSummary.className = `deployment-configuration-summary ${deploymentConfiguration.verdict.level}`; deploymentConfigurationSummary.innerHTML = `<div><span>当前配置</span><b>${verdictLabels[deploymentConfiguration.verdict.level]}</b></div><p><strong>${deploymentConfiguration.verdict.blockers}</strong> 阻断 · <strong>${deploymentConfiguration.verdict.warnings}</strong> 待完善 · <strong>${deploymentConfiguration.verdict.passed}</strong> 已配置</p>`;
    deploymentConfigurationList.innerHTML = deploymentConfiguration.items.map(item => `<article class="${item.status}"><i>${item.status === 'pass' ? '✓' : item.status === 'block' ? '×' : '!'}</i><div><b>${escapeHtml(item.label)}</b><p>${escapeHtml(item.detail)}</p><code>${item.requiredVariables.map(escapeHtml).join(' · ')}</code>${item.action ? `<small>${escapeHtml(item.action)}</small>` : ''}</div><em>${item.status === 'pass' ? '已配置' : item.status === 'block' ? '必须处理' : '建议处理'}</em></article>`).join('');
    deploymentConfigurationBoundary.textContent = deploymentConfiguration.boundary;
  }
  if (canAudit) {
    githubIntegrationState.textContent = githubIntegration.configured ? '已启用' : '待配置'; githubIntegrationState.className = githubIntegration.configured ? 'valid' : 'invalid';
    githubIntegrationEndpoint.innerHTML = githubIntegration.configured ? `<span>Webhook 地址</span><code>${escapeHtml(githubIntegration.endpoint)}</code><small>订阅 push、check_suite、check_run、workflow_run；密钥只配置在服务端。</small>` : '<p>设置 <code>SHIPWITNESS_GITHUB_WEBHOOK_SECRET</code> 后启用。不要把密钥填写到 GitHub 仓库名称或浏览器中。</p>';
    githubDeliveryList.innerHTML = githubIntegration.deliveries.slice(0, 8).map(item => `<article class="${item.status}"><i></i><div><b>${escapeHtml(item.repository || item.event)} · ${escapeHtml(item.branch || '未匹配分支')}</b><p>${escapeHtml(item.event)}${item.action ? ` / ${escapeHtml(item.action)}` : ''} · ${new Date(item.receivedAt).toLocaleString('zh-CN')}</p></div><em>${item.status === 'synced' ? '已同步' : item.status === 'failed' ? '失败' : item.status === 'ignored' ? '已忽略' : '处理中'}</em>${item.status === 'failed' ? `<button data-retry-github="${item.id}">重试</button>` : ''}</article>`).join('') || '<p class="empty">尚未收到 GitHub 事件。</p>';
  }
  if (isOwner) {
    latestReadiness = readiness; const tone = readiness.verdict.level === 'local_only' ? 'blocked' : readiness.verdict.level === 'pilot_ready' ? 'conditional' : 'ready';
    readinessVerdict.className = `readiness-verdict ${tone}`; readinessVerdict.innerHTML = `<div><span>当前结论</span><b>${escapeHtml(readiness.verdict.label)}</b></div><p><strong>${readiness.verdict.blockers}</strong> 阻断 · <strong>${readiness.verdict.warnings}</strong> 警告 · <strong>${readiness.verdict.passed}</strong> 通过</p>`;
    readinessChecks.innerHTML = readiness.checks.map(item => `<article class="${item.status}"><i>${item.status === 'pass' ? '✓' : item.status === 'block' ? '×' : '!'}</i><div><span>${escapeHtml(item.category)}</span><b>${escapeHtml(item.label)}</b><p>${escapeHtml(item.detail)}</p>${item.action ? `<small>下一步：${escapeHtml(item.action)}</small>` : ''}</div><em>${item.status === 'pass' ? '通过' : item.status === 'block' ? '阻断' : '警告'}</em></article>`).join('');
  }
  if (canAudit) {
    const findingLabels = { open: '待处理', remediating: '整改中', fixed_pending_retest: '待复测', verified: '已验证', risk_accepted: '临时接受' }; const severityLabels = { critical: '严重', high: '高危', medium: '中危', low: '低危' };
    const allFindings = securityReviews.flatMap(item => item.findings || []); const blocking = allFindings.filter(item => ['critical', 'high'].includes(item.severity) && item.status !== 'verified' && !(item.status === 'risk_accepted' && new Date(item.riskAcceptance?.expiresAt) > new Date())).length;
    securityReviewState.textContent = securityReviews.length ? `${securityReviews.length} 次评审 · ${blocking} 个阻断` : '尚未登记'; securityReviewState.className = blocking ? 'blocked' : securityReviews.length ? 'ready' : '';
    securityReviewList.innerHTML = securityReviews.slice(0, 5).map(review => `<article><header><div><b>${escapeHtml(review.provider)}</b><small>${escapeHtml(review.reference)} · ${new Date(review.reviewedAt).toLocaleDateString('zh-CN')}</small></div><em>${review.findings.length} 个发现</em></header><p>${escapeHtml(review.summary)}</p><div>${review.findings.map(finding => `<section class="${finding.severity}"><span>${severityLabels[finding.severity]}</span><div><b>${escapeHtml(finding.title)}</b><small>${findingLabels[finding.status] || finding.status}</small></div>${finding.status === 'verified' ? '<em>已闭环</em>' : `<button data-security-finding="${finding.id}" data-security-status="fixed_pending_retest">标记待复测</button><button data-security-finding="${finding.id}" data-security-status="verified">登记复测</button>${isOwner ? `<button data-security-finding="${finding.id}" data-security-status="risk_accepted">临时接受</button>` : ''}`}</section>`).join('') || '<small>本次评审未登记发现项</small>'}</div></article>`).join('') || '<p>尚未登记外部安全评审。</p>';
    securityReviews.slice(0, 5).forEach((review, index) => { const header = securityReviewList.children[index]?.querySelector('header'); if (!header) return; header.insertAdjacentHTML('beforeend', `<div class="security-review-actions"><button data-sign-security-review="${review.id}">${review.dossier ? review.dossier.current ? '重新签署' : '状态已变，重新签署' : '生成签名证据'}</button>${review.dossier ? `<button data-download-security-review="${review.dossier.id}">下载证据包</button>` : ''}</div>`); });
  }
  passwordNotice.hidden = !currentSession.user.mustChangePassword;
  currentMfaStatus = mfaStatus; currentSession.user.mfaEnabled = mfaStatus.enabled; mfaStatusText.textContent = mfaStatus.enabled ? `已启用 · ${mfaStatus.recoveryCodesRemaining} 条恢复码可用` : '未启用；建议管理员和审批人开启'; manageMfa.textContent = mfaStatus.enabled ? '停用' : '启用'; manageMfa.classList.toggle('danger', mfaStatus.enabled);
  const sessionDevice = userAgent => { const value = String(userAgent || ''); const browserName = value.includes('Edg/') ? 'Edge' : value.includes('Chrome/') ? 'Chrome' : value.includes('Firefox/') ? 'Firefox' : value.includes('Safari/') ? 'Safari' : value ? '其他客户端' : '未知客户端'; const platform = value.includes('Macintosh') ? 'macOS' : value.includes('Windows') ? 'Windows' : value.includes('Linux') ? 'Linux' : value.includes('iPhone') ? 'iPhone' : value.includes('Android') ? 'Android' : ''; return `${browserName}${platform ? ` · ${platform}` : ''}`; };
  sessionCount.textContent = `${sessions.length} 个有效会话`;
  sessionList.innerHTML = sessions.map(item => `<article class="${item.current ? 'current' : ''}"><div><b>${escapeHtml(sessionDevice(item.userAgent))}${item.current ? ' · 当前设备' : ''}</b><small>${item.ip ? `${escapeHtml(item.ip)} · ` : ''}${new Date(item.createdAt).toLocaleString('zh-CN')} 登录 · ${new Date(item.expiresAt).toLocaleDateString('zh-CN')} 到期</small></div>${item.current ? '<em>使用中</em>' : `<button data-revoke-session="${item.id}">退出设备</button>`}</article>`).join('');
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
    emailState.textContent = emailStatus.enabled ? 'SMTP 已启用' : '未启用'; emailState.className = emailStatus.enabled ? 'ready' : 'disabled';
    emailHint.textContent = emailStatus.enabled ? `${emailStatus.counts.queued} 待投递 · ${emailStatus.counts.delivered} 已送达 · ${emailStatus.counts.failed} 最终失败${emailStatus.publicUrlConfigured ? '' : ' · 未配置公开地址，邀请仍需手动分享'}` : '设置 SHIPWITNESS_SMTP_HOST 与 SHIPWITNESS_SMTP_FROM 后启用；密码只保存在部署环境。';
    sendTestEmail.disabled = !emailStatus.enabled;
    emailDeliveryList.innerHTML = emailDeliveries.slice(0, 8).map(item => `<article><div><b>${escapeHtml(({ workspace_invitation: '成员邀请', password_reset: '密码重置', release_approval: '发布待审批', run_failed: '验收失败', configuration_test: '配置测试' }[item.kind] || item.kind))}</b><small>${escapeHtml(item.recipient)} · ${item.status === 'delivered' ? '已送达' : item.status === 'failed' ? `失败：${escapeHtml(item.lastError || '')}` : `投递中 · 第 ${item.attempts} 次`}</small></div>${item.status === 'failed' ? `<button data-retry-email="${item.id}">重试</button>` : `<em>${item.status === 'delivered' ? '完成' : '等待'}</em>`}</article>`).join('') || '<p>尚无邮件投递记录</p>';
  }
  auditSection.dataset.accountAllowed = String(canAudit);
  if (canAudit) {
    const identityAuditLabels = { 'workspace.renamed': '重命名工作区', 'user.profile_updated': '更新个人资料', 'user.session_revoked': '退出登录设备', 'user.mfa_enabled': '启用两步验证', 'user.mfa_disabled': '停用两步验证', 'user.password_reset_requested': '申请密码重置', 'user.password_reset_completed': '完成密码重置', 'feedback.created': '提交试点反馈', 'feedback.promoted': '反馈转为验收标准', 'feedback.status_changed': '更新反馈状态', 'feedback.reopened': '重新打开反馈', 'feedback.verified_by_run': '验收证据关闭反馈', 'feedback.exported': '导出试点反馈' };
    Object.assign(identityAuditLabels, { 'backup.created': '创建数据备份', 'backup.verified': '校验备份完整性', 'backup.restore_preflighted': '完成恢复预检', 'backup.recovery_drilled': '完成隔离恢复演练' });
    Object.assign(identityAuditLabels, { 'acceptance_secret.created': '创建验收凭据', 'acceptance_secret.rotated': '轮换验收凭据', 'acceptance_secret.deleted': '删除验收凭据' });
    audit.forEach(item => { item.action = identityAuditLabels[item.action] || item.action; });
    auditIntegrity.textContent = integrity.valid ? `链完整 · ${integrity.checked} 条` : `链异常 · ${integrity.brokenEventId}`; auditIntegrity.className = integrity.valid ? 'valid' : 'invalid';
    auditList.innerHTML = audit.map(item => `<article><i></i><div><b>${escapeHtml(({ 'workspace.initialized': '初始化工作区', 'user.login': '用户登录', 'user.logout': '用户退出', 'user.password_changed': '修改账户密码', 'member.password_reset': '管理员重置成员密码', 'invitation.created': '创建成员邀请', 'invitation.accepted': '接受成员邀请', 'invitation.revoked': '撤销成员邀请', 'workspace.created': '创建工作区', 'workspace.selected': '切换工作区', 'member.added': '添加成员', 'member.role_changed': '调整成员角色', 'member.removed': '移除工作区成员', 'alert.opened': '产生运行告警', 'alert.acknowledged': '确认运行告警', 'alert.resolved': '解决运行告警', 'audit.exported': '生成审计导出', 'retention.updated': '更新数据保留策略', 'retention.cleaned': '清理到期运营数据', 'project.created': '创建项目', 'project.updated': '更新项目', 'contract.created': '创建验收标准', 'contract.updated': '更新验收标准', 'run.created': '创建验收任务', 'run.retry_created': '创建验收重试', 'run.started': '开始执行', 'run.recovered': '接管超时验收任务', 'run.completed': '完成验收', 'issue.created': '创建返工单', 'issue.status_changed': '更新返工状态', 'issue.retest_created': '创建定向复验', 'issue.exported': '导出返工单', 'release.decision_recorded': '签署发布决定', 'api_key.created': '创建机器 API Key', 'api_key.revoked': '撤销机器 API Key', 'webhook.created': '创建发布 Webhook', 'webhook.disabled': '停用发布 Webhook', 'webhook.queued': 'Webhook 已入队', 'webhook.delivered': 'Webhook 已送达', 'webhook.failed': 'Webhook 投递失败', 'dossier.signed': '生成签名卷宗', 'security.master_key_rotated': '轮换主加密密钥' }[item.action] || item.action))}</b><small>${escapeHtml(item.actor?.name || '系统')} · ${new Date(item.at).toLocaleString('zh-CN')}</small></div><code>#${item.sequence}</code></article>`).join('') || '<div class="contract-empty">尚无审计事件</div>';
  }
  renderAccountSettingsTab(); toggleAccount(true);
}
accountBtn.onclick = () => loadAccountPanel().catch(error => toast(error.message)); closeAccount.onclick = () => toggleAccount(false); accountMask.onclick = () => toggleAccount(false);
const confirmBusinessAction = ({ eyebrow = '高影响操作', title, description, confirmLabel, verification = '' }) => new Promise(resolve => {
  if (actionConfirmationResolver) actionConfirmationResolver(false); actionConfirmationResolver = resolve; actionConfirmDialog.dataset.verification = verification; actionConfirmEyebrow.textContent = eyebrow; actionConfirmTitle.textContent = title; actionConfirmDescription.textContent = description; submitActionConfirm.textContent = confirmLabel; actionConfirmVerification.hidden = !verification; actionConfirmVerificationLabel.textContent = verification ? `请输入“${verification}”继续` : ''; actionConfirmInput.value = ''; submitActionConfirm.disabled = Boolean(verification); actionConfirmDialog.showModal(); if (verification) actionConfirmInput.focus(); else submitActionConfirm.focus();
});
actionConfirmInput.oninput = () => { submitActionConfirm.disabled = actionConfirmInput.value.trim() !== actionConfirmDialog.dataset.verification; };
cancelActionConfirm.onclick = () => actionConfirmDialog.close();
actionConfirmDialog.onclose = () => { if (!actionConfirmationResolver) return; const resolve = actionConfirmationResolver; actionConfirmationResolver = null; resolve(false); };
actionConfirmForm.onsubmit = event => { event.preventDefault(); if (submitActionConfirm.disabled || !actionConfirmationResolver) return; const resolve = actionConfirmationResolver; actionConfirmationResolver = null; actionConfirmDialog.close(); resolve(true); };
exportReadiness.onclick = () => { if (!latestReadiness) return; const url = URL.createObjectURL(new Blob([JSON.stringify(latestReadiness, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `ShipWitness-readiness-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); toast('上线就绪报告已导出'); };
securityReviewForm.onsubmit = async event => { event.preventDefault(); try { const hasFinding = securitySeverity.value || securityFindingTitle.value.trim() || securityFindingDescription.value.trim(); if (hasFinding && (!securitySeverity.value || !securityFindingTitle.value.trim() || !securityFindingDescription.value.trim())) throw new Error('发现项需要同时填写级别、标题和说明'); const findings = hasFinding ? [{ severity: securitySeverity.value, title: securityFindingTitle.value, description: securityFindingDescription.value }] : []; await api('/api/security/reviews', { method: 'POST', body: JSON.stringify({ provider: securityProvider.value, reference: securityReference.value, reviewedAt: new Date(`${securityReviewedAt.value}T12:00:00`).toISOString(), scope: securityScope.value, summary: securitySummary.value, findings }) }); securityReviewForm.reset(); securityReviewedAt.value = new Date().toISOString().slice(0, 10); await loadAccountPanel(); toast('安全评审已登记并接入发布门禁'); } catch (error) { toast(error.message); } };
const localDateValue = date => { const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 10); };
const openSecurityFindingAction = (button, status) => {
  pendingSecurityFindingAction = { findingId: button.dataset.securityFinding, status };
  const findingTitle = button.closest('section')?.querySelector('b')?.textContent || '安全发现'; const riskAcceptance = status === 'risk_accepted';
  securityFindingActionEyebrow.textContent = riskAcceptance ? '负责人风险决定' : '独立复测记录'; securityFindingActionTitle.textContent = riskAcceptance ? '临时接受安全风险' : '登记复测通过'; securityFindingActionDescription.textContent = findingTitle;
  securityRetestFields.hidden = riskAcceptance; securityRiskFields.hidden = !riskAcceptance; securityRetestEvidence.required = !riskAcceptance; securityRiskRationale.required = riskAcceptance; securityRiskExpiresAt.required = riskAcceptance;
  securityRetestEvidence.value = ''; securityRiskRationale.value = ''; const today = new Date(); const earliest = new Date(today.getTime() + 86400_000); const latest = new Date(today.getTime() + 89 * 86400_000); const suggested = new Date(today.getTime() + 30 * 86400_000);
  securityRiskExpiresAt.min = localDateValue(earliest); securityRiskExpiresAt.max = localDateValue(latest); securityRiskExpiresAt.value = localDateValue(suggested); securityFindingActionError.hidden = true; securityFindingDialog.showModal();
};
closeSecurityFindingDialog.onclick = cancelSecurityFindingDialog.onclick = () => { pendingSecurityFindingAction = null; securityFindingDialog.close(); };
securityFindingActionForm.onsubmit = async event => {
  event.preventDefault(); if (!pendingSecurityFindingAction) return; submitSecurityFindingAction.disabled = true; securityFindingActionError.hidden = true;
  try {
    const payload = { status: pendingSecurityFindingAction.status };
    if (payload.status === 'verified') payload.evidence = securityRetestEvidence.value;
    if (payload.status === 'risk_accepted') { payload.rationale = securityRiskRationale.value; payload.expiresAt = new Date(`${securityRiskExpiresAt.value}T23:59:59.999`).toISOString(); }
    await api(`/api/security/findings/${pendingSecurityFindingAction.findingId}`, { method: 'PATCH', body: JSON.stringify(payload) }); const message = payload.status === 'verified' ? '复测证据已登记' : `风险已临时接受至 ${securityRiskExpiresAt.value}`;
    pendingSecurityFindingAction = null; securityFindingDialog.close(); await loadAccountPanel(); toast(message);
  } catch (error) { securityFindingActionError.textContent = error.message; securityFindingActionError.hidden = false; }
  finally { submitSecurityFindingAction.disabled = false; }
};
securityReviewList.onclick = async event => { const signButton = event.target.closest('[data-sign-security-review]'); const downloadButton = event.target.closest('[data-download-security-review]'); const findingButton = event.target.closest('[data-security-finding]'); try { if (signButton) { const document = await api(`/api/security/reviews/${signButton.dataset.signSecurityReview}/sign`, { method: 'POST' }); downloadJson(document, `ShipWitness-security-review-${document.payload.review.reference}.json`); await loadAccountPanel(); toast('签名安全整改证据包已生成'); return; } if (downloadButton) { const document = await api(`/api/security-review-dossiers/${downloadButton.dataset.downloadSecurityReview}`); downloadJson(document, `ShipWitness-security-review-${document.payload.review.reference}.json`); return; } if (!findingButton) return; const status = findingButton.dataset.securityStatus; if (['verified', 'risk_accepted'].includes(status)) return openSecurityFindingAction(findingButton, status); await api(`/api/security/findings/${findingButton.dataset.securityFinding}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadAccountPanel(); toast('已标记等待复测'); } catch (error) { toast(error.message); } };
githubDeliveryList.onclick = async event => { const button = event.target.closest('[data-retry-github]'); if (!button) return; button.disabled = true; try { await api(`/api/github-deliveries/${button.dataset.retryGithub}/retry`, { method: 'POST' }); await loadAccountPanel(); toast('GitHub 事件已重新同步'); } catch (error) { toast(error.message); button.disabled = false; } };
workspaceList.onclick = async event => { const button = event.target.closest('[data-workspace-id]'); if (!button || button.disabled) return; await api(`/api/workspaces/${button.dataset.workspaceId}/select`, { method: 'POST' }); location.reload(); };
workspaceForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: newWorkspaceName.value }) }); location.reload(); } catch (error) { toast(error.message); } };
profileForm.onsubmit = async event => { event.preventDefault(); try { const user = await api('/api/account/profile', { method: 'PATCH', body: JSON.stringify({ name: profileName.value }) }); currentSession.user = user; accountBtn.textContent = `${currentSession.workspace.name} · ${user.name}`; await loadAccountPanel(); toast('个人资料已保存'); } catch (error) { toast(error.message); } };
workspaceIdentityForm.onsubmit = async event => { event.preventDefault(); try { const workspace = await api(`/api/workspaces/${currentSession.workspace.id}`, { method: 'PATCH', body: JSON.stringify({ name: workspaceIdentityName.value }) }); currentSession.workspace = workspace; accountBtn.textContent = `${workspace.name} · ${currentSession.user.name}`; await loadAccountPanel(); toast('工作区名称已更新'); } catch (error) { toast(error.message); } };
memberForm.onsubmit = async event => { event.preventDefault(); try { const created = await api('/api/invitations', { method: 'POST', body: JSON.stringify({ name: memberName.value, email: memberEmail.value, role: memberRole.value, expiresInHours: Number(invitationExpiry.value) }) }); const link = `${location.origin}${created.invitePath}`; memberForm.reset(); invitationSecret.hidden = false; invitationSecret.innerHTML = `<b>邀请链接只显示一次，请安全发送给 ${escapeHtml(created.email)}</b><code>${escapeHtml(link)}</code>`; await loadAccountPanel(); invitationSecret.hidden = false; toast(created.emailQueued ? '邀请已创建并加入邮件队列' : '一次性邀请已创建'); } catch (error) { toast(error.message); } };
invitationList.onclick = async event => { const button = event.target.closest('[data-revoke-invitation]'); if (!button) return; const email = button.closest('article')?.querySelector('b')?.textContent || '该成员'; if (!await confirmBusinessAction({ eyebrow: '成员访问', title: `撤销 ${email} 的邀请？`, description: '撤销后，这个一次性邀请链接会立即失效，成员不能再用它加入工作区。', confirmLabel: '撤销邀请' })) return; try { await api(`/api/invitations/${button.dataset.revokeInvitation}`, { method: 'DELETE' }); await loadAccountPanel(); toast('邀请已撤销'); } catch (error) { toast(error.message); } };
memberList.onchange = async event => { const select = event.target.closest('[data-member-role]'); if (!select) return; try { const result = await api(`/api/members/${select.dataset.memberRole}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }); if (result.id === currentSession.user.id) return location.reload(); await loadAccountPanel(); toast('成员角色已更新'); } catch (error) { toast(error.message); await loadAccountPanel(); } };
memberList.onclick = async event => {
  const access = event.target.closest('[data-member-access]');
  if (access) { const enable = access.dataset.memberAction === 'enable'; const name = access.dataset.memberName; if (!await confirmBusinessAction({ eyebrow: '成员访问', title: `${enable ? '恢复' : '停用'} ${name} 的访问？`, description: enable ? '该成员将重新获得当前工作区访问权限。' : '该成员会立即退出当前工作区，名下 API Key 同时撤销；历史证据继续保留。', confirmLabel: enable ? '恢复访问' : '停用访问' })) return; try { const result = await api(`/api/members/${access.dataset.memberAccess}/${enable ? 'enable' : 'disable'}`, { method: 'POST' }); await loadAccountPanel(); toast(enable ? '成员访问已恢复' : `成员已停用，退出 ${result.sessionsRevoked} 个会话`); } catch (error) { toast(error.message); } return; }
  const revokeSessions = event.target.closest('[data-revoke-member-sessions]');
  if (revokeSessions) { if (!await confirmBusinessAction({ eyebrow: '账户安全', title: `让 ${revokeSessions.dataset.memberName} 的设备全部下线？`, description: '该成员在当前工作区的登录会话会立即失效，但账号和角色保持不变。', confirmLabel: '强制下线' })) return; try { const result = await api(`/api/members/${revokeSessions.dataset.revokeMemberSessions}/sessions/revoke`, { method: 'POST' }); await loadAccountPanel(); toast(`已退出 ${result.sessionsRevoked} 个会话`); } catch (error) { toast(error.message); } return; }
  const resetMfa = event.target.closest('[data-reset-member-mfa]');
  if (resetMfa) { if (!await confirmBusinessAction({ eyebrow: '高风险账户操作', title: `重置 ${resetMfa.dataset.memberName} 的两步验证？`, description: '验证器密钥和恢复码会立即失效，所有设备退出。成员下次登录后应重新绑定。', confirmLabel: '确认重置' })) return; try { const result = await api(`/api/members/${resetMfa.dataset.resetMemberMfa}/mfa/reset`, { method: 'POST' }); await loadAccountPanel(); toast(`MFA 已重置，退出 ${result.sessionsRevoked} 个会话`); } catch (error) { toast(error.message); } return; }
  const reset = event.target.closest('[data-reset-member]');
  if (reset) { resetMembershipId.value = reset.dataset.resetMember; memberPasswordDialog.querySelector('h3').textContent = `重置 ${reset.dataset.memberName} 的密码`; resetMemberPassword.value = ''; memberPasswordDialog.showModal(); return; }
  const button = event.target.closest('[data-remove-member]'); if (!button) return; const memberName = button.closest('article')?.querySelector('b')?.textContent || '该成员'; if (!await confirmBusinessAction({ eyebrow: '成员访问', title: `从工作区移除 ${memberName}？`, description: '该成员在当前工作区的登录会话会立即失效；其个人数据不会被删除。', confirmLabel: '移除成员' })) return;
  try { const result = await api(`/api/members/${button.dataset.removeMember}`, { method: 'DELETE' }); result.self ? location.reload() : await loadAccountPanel(); toast('成员已移除'); } catch (error) { toast(error.message); }
};
const closeMemberPasswordDialog = () => memberPasswordDialog.close();
cancelMemberPassword.onclick = closeMemberPasswordDialog; cancelMemberPasswordFooter.onclick = closeMemberPasswordDialog;
memberPasswordResetForm.onsubmit = async event => { event.preventDefault(); try { const result = await api(`/api/members/${resetMembershipId.value}/password`, { method: 'POST', body: JSON.stringify({ newPassword: resetMemberPassword.value }) }); closeMemberPasswordDialog(); await loadAccountPanel(); toast(`密码已重置，已退出 ${result.sessionsRevoked} 个会话`); } catch (error) { toast(error.message); } };
alertsList.onclick = async event => { const button = event.target.closest('[data-ack-alert]'); if (!button) return; try { await api(`/api/alerts/${button.dataset.ackAlert}`, { method: 'PATCH', body: JSON.stringify({ status: 'acknowledged' }) }); await loadAccountPanel(); toast('告警已确认并写入审计'); } catch (error) { toast(error.message); } };
createAuditExport.onclick = async () => { createAuditExport.disabled = true; try { const item = await api('/api/audit-exports', { method: 'POST' }); auditExportSummary.textContent = `${item.eventCount} 条事件 · 刚刚生成`; downloadAuditExport.href = item.downloadUrl; downloadAuditExport.hidden = false; toast('审计导出已生成，可立即下载'); } catch (error) { toast(error.message); } finally { createAuditExport.disabled = false; } };
createBackup.onclick = async () => { if (!await confirmBusinessAction({ eyebrow: '灾备保护', title: '现在创建 PostgreSQL 备份？', description: '系统会生成数据库转储、复制证据文件并写入 SHA-256 清单。备份完成后仍需点击“校验”才算可用恢复点。', confirmLabel: '创建备份' })) return; createBackup.disabled = true; try { await api('/api/backups', { method: 'POST' }); await loadAccountPanel(); toast('备份已创建，请继续校验完整性'); } catch (error) { toast(error.message); } finally { createBackup.disabled = false; } };
backupList.onclick = async event => {
  const verify = event.target.closest('[data-verify-backup]'); const preflight = event.target.closest('[data-preflight-backup]'); const drill = event.target.closest('[data-drill-backup]');
  try {
    if (verify) { const result = await api(`/api/backups/${verify.dataset.verifyBackup}/verify`, { method: 'POST' }); await loadAccountPanel(); toast(`备份有效，已校验 ${result.filesVerified} 个文件`); return; }
    if (drill) { const id = drill.dataset.drillBackup; const verification = `演练恢复 ${id}`; if (!await confirmBusinessAction({ eyebrow: '真实恢复演练', title: '恢复到隔离数据库并核验？', description: '系统将清空并覆盖专用演练数据库，不会修改当前生产数据库。备份哈希、Schema 和核心记录都会重新核验。', confirmLabel: '开始恢复演练', verification })) return; const result = await api(`/api/backups/${id}/drill`, { method: 'POST', body: JSON.stringify({ confirmation: verification }) }); await loadAccountPanel(); toast(`恢复演练通过：核验 ${result.counts.runs} 个任务`); return; }
    if (!preflight) return; const id = preflight.dataset.preflightBackup; const verification = `预检恢复 ${id}`;
    if (!await confirmBusinessAction({ eyebrow: '恢复演练', title: '生成恢复预检方案？', description: '恢复会覆盖目标数据库。本步骤只校验备份并生成停服恢复命令，不会修改当前数据。', confirmLabel: '生成预检', verification })) return;
    const result = await api(`/api/backups/${id}/restore-preflight`, { method: 'POST', body: JSON.stringify({ confirmation: verification }) }); backupPreflight.hidden = false; backupPreflight.innerHTML = `<b>${result.canRestore ? '恢复预检通过' : '当前版本不兼容'}</b><p>${escapeHtml(result.warning)}</p><code>${escapeHtml(result.command)}</code><small>建议先恢复到独立数据库，并核验历史任务、截图和签名证据。</small>`; await loadAccountPanel(); backupPreflight.hidden = false; toast(result.canRestore ? '恢复预检已生成' : '备份与当前 Schema 不兼容');
  } catch (error) { toast(error.message); }
};
retentionForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/retention', { method: 'PUT', body: JSON.stringify({ operationalDays: Number(operationalDays.value) }) }); retentionPreviewState = null; retentionResult.hidden = true; toast('数据保留策略已保存'); await loadAccountPanel(); } catch (error) { toast(error.message); } };
previewRetention.onclick = async () => { try { retentionPreviewState = await api('/api/retention/preview'); const counts = retentionPreviewState.counts; retentionResult.hidden = false; retentionResult.innerHTML = `<b>${retentionPreviewState.total} 条运营数据符合清理条件</b><small>过期会话 ${counts.sessions} · Webhook 投递 ${counts.webhookDeliveries} · GitHub 事件 ${counts.githubDeliveries} · 邮件投递 ${counts.emailDeliveries} · 幂等记录 ${counts.idempotencyRecords} · 已解决告警 ${counts.alerts} · 已失效邀请 ${counts.invitations}</small>${retentionPreviewState.total ? '<button data-clean-retention>确认清理</button>' : ''}<em>审计、验收记录、截图与签名卷宗不会被删除</em>`; } catch (error) { toast(error.message); } };
retentionResult.onclick = async event => { if (!event.target.closest('[data-clean-retention]') || !retentionPreviewState) return; const verification = `清理 ${retentionPreviewState.total} 条`; if (!await confirmBusinessAction({ eyebrow: '永久数据操作', title: `永久清理 ${retentionPreviewState.total} 条到期数据？`, description: '过期会话和投递记录将无法恢复。审计、验收记录、截图和签名卷宗继续保留。', confirmLabel: '永久清理', verification })) return; try { const result = await api('/api/retention/cleanup', { method: 'POST', body: JSON.stringify({ asOf: retentionPreviewState.asOf, token: retentionPreviewState.token }) }); retentionPreviewState = null; retentionResult.innerHTML = `<b>已清理 ${result.total} 条到期运营数据</b><small>截止 ${new Date(result.cutoff).toLocaleString('zh-CN')}</small>`; toast('到期运营数据已安全清理'); await loadAccountPanel(); } catch (error) { toast(error.message); } };
passwordForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value }) }); currentSession.user.mustChangePassword = false; passwordForm.reset(); toast('密码已更新，其他会话已退出'); await loadAccountPanel(); } catch (error) { toast(error.message); } };
const closeMfa = () => { mfaDialogMode = null; mfaDialog.close(); mfaForm.reset(); mfaSetupDetails.hidden = true; mfaRecoveryCodes.hidden = true; mfaVerifyLabel.hidden = true; mfaError.hidden = true; };
closeMfaDialog.onclick = cancelMfaDialog.onclick = closeMfa;
manageMfa.onclick = () => { mfaDialogMode = currentMfaStatus?.enabled ? 'disable' : 'setup'; mfaForm.reset(); mfaSetupDetails.hidden = true; mfaRecoveryCodes.hidden = true; mfaError.hidden = true; mfaPasswordLabel.hidden = false; mfaCurrentPassword.required = true; mfaVerifyLabel.hidden = mfaDialogMode === 'setup'; mfaVerifyCode.required = mfaDialogMode === 'disable'; mfaDialogTitle.textContent = mfaDialogMode === 'disable' ? '停用两步验证' : '启用两步验证'; mfaDialogDescription.textContent = mfaDialogMode === 'disable' ? '输入当前密码及动态验证码或恢复码。停用后其他设备会退出。' : '先用当前密码确认身份，再把密钥添加到验证器应用。'; submitMfa.textContent = mfaDialogMode === 'disable' ? '确认停用' : '生成绑定密钥'; submitMfa.classList.toggle('danger', mfaDialogMode === 'disable'); mfaDialog.showModal(); mfaCurrentPassword.focus(); };
mfaForm.onsubmit = async event => { event.preventDefault(); submitMfa.disabled = true; mfaError.hidden = true; try {
  if (mfaDialogMode === 'setup') { const setup = await api('/api/account/mfa/setup', { method: 'POST', body: JSON.stringify({ currentPassword: mfaCurrentPassword.value }) }); mfaSetupSecret.textContent = setup.secret; mfaSetupDetails.hidden = false; mfaPasswordLabel.hidden = true; mfaCurrentPassword.required = false; mfaVerifyLabel.hidden = false; mfaVerifyCode.required = true; mfaDialogDescription.textContent = '密钥只在本次绑定过程中显示。验证成功后请安全保存恢复码。'; submitMfa.textContent = '验证并启用'; mfaDialogMode = 'enable'; mfaVerifyCode.focus(); }
  else if (mfaDialogMode === 'enable') { const enabled = await api('/api/account/mfa/enable', { method: 'POST', body: JSON.stringify({ code: mfaVerifyCode.value }) }); mfaSetupDetails.hidden = true; mfaVerifyLabel.hidden = true; mfaVerifyCode.required = false; mfaRecoveryCodes.hidden = false; mfaRecoveryCodes.innerHTML = `<b>恢复码只显示这一次</b><p>每条只能使用一次，请保存到密码管理器。剩余 ${enabled.recoveryCodes.length} 条。</p><div>${enabled.recoveryCodes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}</div>`; mfaDialogDescription.textContent = '两步验证已启用，其他登录设备已安全退出。'; submitMfa.textContent = '我已保存恢复码'; mfaDialogMode = 'complete'; await loadAccountPanel(); }
  else if (mfaDialogMode === 'complete') closeMfa();
  else { await api('/api/account/mfa/disable', { method: 'POST', body: JSON.stringify({ currentPassword: mfaCurrentPassword.value, code: mfaVerifyCode.value }) }); closeMfa(); await loadAccountPanel(); toast('两步验证已停用，其他设备已退出'); }
} catch (error) { mfaError.textContent = error.message; mfaError.hidden = false; } finally { submitMfa.disabled = false; } };
sessionList.onclick = async event => { const button = event.target.closest('[data-revoke-session]'); if (!button) return; const device = button.closest('article')?.querySelector('b')?.textContent || '该设备'; if (!await confirmBusinessAction({ eyebrow: '账户安全', title: `退出 ${device}？`, description: '这个设备的登录会话会立即失效，需要重新输入账号密码才能访问工作区。当前设备不会受到影响。', confirmLabel: '退出该设备' })) return; try { await api(`/api/account/sessions/${button.dataset.revokeSession}/revoke`, { method: 'POST' }); await loadAccountPanel(); toast('设备已退出并写入安全审计'); } catch (error) { toast(error.message); } };
apiKeyForm.onsubmit = async event => { event.preventDefault(); try { const scopes = apiKeyPurpose.value === 'agent' ? ['acceptance:read', 'acceptance:write', 'gate:read', 'dossier:read'] : ['gate:read', 'dossier:read']; const created = await api('/api/api-keys', { method: 'POST', body: JSON.stringify({ name: apiKeyName.value, scopes }) }); apiKeySecret.hidden = false; apiKeySecret.innerHTML = `<b>只显示一次，请立即保存</b><code>${escapeHtml(created.token)}</code>`; apiKeyName.value = ''; await loadAccountPanel(); apiKeySecret.hidden = false; } catch (error) { toast(error.message); } };
webhookForm.onsubmit = async event => { event.preventDefault(); try { const created = await api('/api/webhooks', { method: 'POST', body: JSON.stringify({ name: webhookName.value, url: webhookUrl.value, events: ['release.decision'] }) }); webhookSecret.hidden = false; webhookSecret.innerHTML = `<b>签名密钥只显示一次</b><code>${escapeHtml(created.secret)}</code>`; webhookForm.reset(); await loadAccountPanel(); webhookSecret.hidden = false; } catch (error) { toast(error.message); } };
const resetAcceptanceSecretForm = () => { acceptanceSecretForm.reset(); acceptanceSecretId.value = ''; acceptanceSecretName.disabled = false; acceptanceSecretValue.placeholder = '凭据值（保存后不再显示）'; acceptanceSecretSubmit.textContent = '安全保存'; cancelAcceptanceSecretRotation.hidden = true; };
acceptanceSecretForm.onsubmit = async event => { event.preventDefault(); try { const rotating = Boolean(acceptanceSecretId.value); await api(rotating ? `/api/acceptance-secrets/${acceptanceSecretId.value}` : '/api/acceptance-secrets', { method: rotating ? 'PATCH' : 'POST', body: JSON.stringify({ name: acceptanceSecretName.value, value: acceptanceSecretValue.value, expiresInDays: Number(acceptanceSecretExpiry.value) }) }); resetAcceptanceSecretForm(); await loadAccountPanel(); toast(rotating ? '验收凭据已原地轮换并更新有效期' : '验收凭据已加密保存'); } catch (error) { toast(error.message); } };
cancelAcceptanceSecretRotation.onclick = resetAcceptanceSecretForm;
acceptanceSecretList.onclick = async event => { const rotate = event.target.closest('[data-rotate-acceptance-secret]'); if (rotate) { acceptanceSecretId.value = rotate.dataset.rotateAcceptanceSecret; acceptanceSecretName.value = rotate.dataset.secretName; acceptanceSecretName.disabled = true; acceptanceSecretValue.value = ''; acceptanceSecretValue.placeholder = `输入 ${rotate.dataset.secretName} 的新值`; acceptanceSecretSubmit.textContent = '确认轮换'; cancelAcceptanceSecretRotation.hidden = false; acceptanceSecretValue.focus(); return; } const button = event.target.closest('[data-delete-acceptance-secret]'); if (!button || button.disabled) return; const name = button.closest('article')?.querySelector('b')?.textContent || '该凭据'; if (!await confirmBusinessAction({ eyebrow: '验收凭据', title: `删除 ${name}？`, description: '删除后历史证据仍保留；系统已确认当前没有启用的验收标准引用它。', confirmLabel: '删除凭据' })) return; try { await api(`/api/acceptance-secrets/${button.dataset.deleteAcceptanceSecret}`, { method: 'DELETE' }); await loadAccountPanel(); toast('验收凭据已删除'); } catch (error) { toast(error.message); } };
apiKeyList.onclick = async event => { const button = event.target.closest('[data-revoke-key]'); if (!button) return; const keyName = button.closest('article')?.querySelector('b')?.textContent || '该 API Key'; if (!await confirmBusinessAction({ eyebrow: '机器访问', title: `撤销 ${keyName}？`, description: '使用这个 Key 的发布流水线或 Coding Agent 会立即失去访问权限。', confirmLabel: '撤销 API Key' })) return; try { await api(`/api/api-keys/${button.dataset.revokeKey}`, { method: 'DELETE' }); await loadAccountPanel(); toast('API Key 已撤销'); } catch (error) { toast(error.message); } };
webhookList.onclick = async event => { const button = event.target.closest('[data-disable-webhook]'); if (!button) return; const webhookName = button.closest('article')?.querySelector('b')?.textContent || '该 Webhook'; if (!await confirmBusinessAction({ eyebrow: '事件投递', title: `停用 ${webhookName}？`, description: '停用后不会再创建新的事件投递；历史投递记录继续保留。', confirmLabel: '停用 Webhook' })) return; try { await api(`/api/webhooks/${button.dataset.disableWebhook}`, { method: 'DELETE' }); await loadAccountPanel(); toast('Webhook 已停用'); } catch (error) { toast(error.message); } };
sendTestEmail.onclick = async () => { sendTestEmail.disabled = true; try { const result = await api('/api/email/test', { method: 'POST' }); toast(`测试邮件已加入队列：${result.recipient}`); await loadAccountPanel(); } catch (error) { toast(error.message); } finally { sendTestEmail.disabled = false; } };
emailDeliveryList.onclick = async event => { const button = event.target.closest('[data-retry-email]'); if (!button) return; try { await api(`/api/email-deliveries/${button.dataset.retryEmail}/retry`, { method: 'POST' }); await loadAccountPanel(); toast('邮件已重新加入投递队列'); } catch (error) { toast(error.message); } };

document.body.insertAdjacentHTML('beforeend', `<aside class="run-task-panel" id="runTaskPanel" aria-hidden="true"><header><div><span>真实任务</span><h2>验收执行详情</h2></div><button id="closeRunTask" aria-label="关闭">×</button></header><section class="run-task-state"><div><span id="runTaskId">—</span><strong id="runTaskStatus">等待读取</strong></div><p id="runTaskSummary">从后端读取任务状态和真实执行证据。</p></section><section class="system-evidence" id="systemEvidence"><div class="empty-task">尚未执行检查</div></section><section class="criteria-results"><span class="field-label">验收标准</span><div id="backendCriteria"></div></section><section class="run-decisions" id="runDecisionHistory" hidden></section><footer><p id="runTaskBoundary">只有配置了浏览器步骤和结果断言的标准才可能自动通过。</p><div><button id="recordDecisionBtn" class="decision-action" hidden>记录发布决定</button><button id="executeRunBtn">执行验收</button></div></footer></aside><div class="run-task-mask" id="runTaskMask" hidden></div>`);
document.body.insertAdjacentHTML('beforeend', `<aside class="contracts-panel" id="contractsPanel" aria-hidden="true"><header><div><span>项目资产</span><h2>验收标准库</h2><p>标准会在任务创建时生成独立快照，后续修改不会改变历史验收。</p></div><button id="closeContracts" aria-label="关闭">×</button></header><section class="contracts-toolbar"><div><b id="activeContractCount">0 条启用</b><small>停用标准不会进入新任务</small></div><div class="contract-toolbar-actions"><button id="contractAssetsBtn" class="secondary" type="button">复用标准</button><button id="newContractBtn">＋ 新增标准</button></div></section><form class="contract-editor" id="contractEditor" hidden><input type="hidden" id="contractEditId"><div class="contract-form-row"><label><span>标准编号</span><input id="contractCode" placeholder="例如 AUTH-02" required></label><label><span>标准名称</span><input id="contractTitle" placeholder="用户能看懂的结果" required></label></div><label><span>正确结果描述</span><textarea id="contractDescription" rows="3" required></textarea></label><div class="contract-form-row"><label><span>分类</span><select id="contractCategory"><option>业务流程</option><option>权限</option><option>数据</option><option>安全</option><option>性能</option></select></label><label><span>级别</span><select id="contractSeverity"><option value="blocker">阻断发布</option><option value="major">重要</option><option value="minor">一般</option></select></label></div><section class="step-builder"><header><div><b>浏览器执行步骤</b><small>至少包含一个“检查”步骤，才可能自动通过</small></div><button type="button" id="addContractStep">＋ 添加步骤</button></header><div id="contractSteps"></div></section><footer><button type="button" class="contract-cancel" id="cancelContractEdit">取消</button><button type="submit" class="contract-save">保存标准</button></footer></form><section class="contract-list" id="contractList"><div class="contract-empty">正在读取标准…</div></section></aside><div class="contracts-mask" id="contractsMask" hidden></div><dialog id="contractAssetsDialog" class="contract-assets-dialog"><form id="contractAssetsForm"><header><div><span>团队资产</span><h3>复用验收标准</h3><p>从当前工作区的其他项目复制，或导入 ShipWitness JSON 标准包。</p></div><button type="button" id="closeContractAssets">×</button></header><section><label><span>从项目复制</span><select id="contractSourceProject"><option value="">选择来源项目</option></select></label><div class="asset-divider"><span>或</span></div><label><span>导入 JSON 标准包</span><input id="contractPackFile" type="file" accept="application/json,.json"></label><button id="previewContractImport" type="button" class="asset-preview">预览导入</button><div id="contractImportPreview" class="asset-preview-result">选择来源后先预览，不会立即修改数据。</div><label><span>编号冲突时</span><select id="contractConflictMode"><option value="skip">保留当前标准，跳过冲突项</option><option value="replace">用导入内容生成新版本</option></select></label></section><section class="asset-bulk"><b>批量状态</b><div><button type="button" data-bulk-contracts="true">全部启用</button><button type="button" data-bulk-contracts="false">全部停用</button><button type="button" id="exportContractPack">导出当前标准包</button></div></section><footer><button type="button" id="cancelContractAssets">取消</button><button type="submit" id="applyContractImport" disabled>确认导入</button></footer></form></dialog>`);

const syncWizardContracts = contracts => {
  const enabled = contracts.filter(item => item.enabled);
  criteriaList.innerHTML = enabled.map(item => `<label data-contract-id="${item.id}"><input type="checkbox" checked><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.description)}</small></span><em>${escapeHtml(item.code)} · V${item.version}</em></label>`).join('') || '<p class="contract-empty">标准库暂无启用标准，请先添加或启用标准。</p>';
};

const renderContracts = () => {
  const active = backendContracts.filter(item => item.enabled).length;
  contractCount.textContent = active;
  activeContractCount.textContent = `${active} 条启用`;
  contractList.innerHTML = backendContracts.map(item => `<article class="contract-item ${item.enabled ? '' : 'disabled'} ${(item.missingSecretRefs || []).length ? 'dependency-missing' : ''}" data-id="${item.id}"><div class="contract-item-head"><span>${escapeHtml(item.code)} · V${item.version}</span><em>${(item.missingSecretRefs || []).length ? '缺少凭据' : item.severity === 'blocker' ? '阻断' : item.severity === 'major' ? '重要' : '一般'}</em></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p>${(item.missingSecretRefs || []).length ? `<div class="contract-dependency-warning">管理员需配置：${item.missingSecretRefs.map(escapeHtml).join(' · ')}</div>` : ''}<footer><span>${escapeHtml(item.category)} · ${(item.steps || []).length} 个步骤 · ${item.enabled ? '已启用' : '已停用'}</span><div><button data-action="toggle">${item.enabled ? '停用' : '启用'}</button><button data-action="edit">编辑</button></div></footer></article>`).join('') || '<div class="contract-empty">还没有验收标准</div>';
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
    nextAction.innerHTML = '<span class="mini-label">推荐开始方式</span><h3>5 分钟创建首次验收</h3><p>启动包会生成真实项目、可执行标准和首个任务。</p><button class="decide" id="dashboardStarter">使用首次向导 <span>→</span></button><button class="text-action" id="dashboardConnect">手动接入项目</button>';
    document.querySelector('#dashboardStarter').onclick = () => openStarter(); document.querySelector('#dashboardConnect').onclick = () => toggleConnect(true);
    return;
  }
  heading.innerHTML = `${escapeHtml(project.name)} <em>发布验收</em>`;
  overline.textContent = `项目 / ${project.name}${run ? ` / ${run.id.toUpperCase()}` : ''}`;
  scope.innerHTML = `<span>当前分支</span><strong><code>${escapeHtml(project.branch)}</code></strong><small>${run ? `${new Date(run.createdAt).toLocaleString('zh-CN')}${run.repositorySnapshot ? ` · 提交 ${escapeHtml(run.repositorySnapshot.commit.shortSha)}` : ' · 未绑定远端提交'}` : '尚未创建验收任务'}</small>`;
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
  document.querySelector('#dashboardContracts')?.addEventListener('click', () => contractsBtn.click()); document.querySelector('#dashboardExport')?.addEventListener('click', () => downloadRunDossier()); document.querySelector('#dashboardSign')?.addEventListener('click', async () => { try { const signedDocument = await api(`/api/dossiers/${run.id}/sign`, { method: 'POST' }); const blob = new Blob([JSON.stringify(signedDocument, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `ShipWitness-signed-${run.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); toast('签名卷宗已生成，可用 CLI 离线验签'); } catch (error) { toast(error.message); } });
}

let starterKitsCache = [];
async function openStarter({ additional = false } = {}) {
  starterError.hidden = true;
  starterDialog.querySelector('header span').textContent = additional ? '项目接入向导' : '首次使用向导';
  starterDialog.querySelector('header h2').textContent = additional ? '接入另一个验收项目' : '创建第一个真实验收';
  starterDialog.querySelector('header p').textContent = additional ? '选择适合的启动包，一次创建项目、验收标准和首个任务。' : '选择场景并填写目标，系统会一次创建项目、可执行标准和首个验收任务。';
  starterKitsCache = starterKitsCache.length ? starterKitsCache : await api('/api/starter-kits');
  starterKitList.innerHTML = starterKitsCache.map((kit, index) => `<label><input type="radio" name="starterKit" value="${kit.id}" ${index === 0 ? 'checked' : ''}><span><b>${escapeHtml(kit.icon)}</b><strong>${escapeHtml(kit.name)}</strong><small>${escapeHtml(kit.description)}</small></span></label>`).join('');
  if (!starterDialog.open) starterDialog.showModal();
}
closeStarter.onclick = () => { sessionStorage.setItem('shipwitness.starter.dismissed', '1'); starterDialog.close(); };
starterForm.onsubmit = async event => {
  event.preventDefault(); applyStarter.disabled = true; applyStarter.textContent = '正在创建启动包…'; starterError.hidden = true;
  try {
    const kitId = new FormData(starterForm).get('starterKit');
    const created = await api('/api/starter-kits/apply', { method: 'POST', body: JSON.stringify({ kitId, name: starterName.value, repo: starterRepo.value, url: starterUrl.value, branch: starterBranch.value, startPath: starterPath.value, expectedText: starterExpectedText.value, requirement: starterRequirement.value }) });
    backendProjectId = created.project.id; backendProject = created.project; backendRunId = created.run.id;
    applyStarter.textContent = '正在检查测试环境…';
    const preflight = await api(`/api/projects/${created.project.id}/preflight`, { method: 'POST' });
    const executable = preflight.checks.url.status === 'ready' && preflight.checks.browser.status === 'ready';
    if (starterExecute.checked && executable) { applyStarter.textContent = '正在执行浏览器验收…'; await api(`/api/runs/${created.run.id}/execute`, { method: 'POST' }); }
    starterDialog.close(); sessionStorage.removeItem('shipwitness.starter.dismissed'); await bootstrapBackend();
    if (starterExecute.checked && executable) { await loadRunTask(); toast('首次验收已完成，截图和步骤证据已保存'); }
    else { toggleConnect(true); toast(executable ? '首个任务已创建，可随时执行' : '项目已创建，请根据环境检查结果完成接入'); }
  } catch (error) { starterError.textContent = error.message; starterError.hidden = false; }
  finally { applyStarter.disabled = false; applyStarter.textContent = '创建并开始验收'; }
};

async function bootstrapBackend() {
  try {
    await api('/api/health');
    setServiceState(true, '服务已连接');
    const projects = await api('/api/projects');
    const runs = await api('/api/runs');
    const query = new URLSearchParams(location.search);
    const requestedRun = runs.find(item => item.id === query.get('run'));
    const requestedProjectId = requestedRun?.projectId || query.get('project');
    const requestedProject = projects.find(item => item.id === requestedProjectId);
    const saved = requestedProject || projects.find(item => item.selected) || projects[0];
    backendProjects = projects;
    if (saved && !saved.selected) await api(`/api/projects/${saved.id}/select`, { method: 'POST' });
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
      await loadContracts();
    } else {
      backendProjectId = null; backendProject = null; backendRunId = null; backendContracts = []; renderContracts();
      connectRepo.value = ''; connectUrl.value = ''; connectBranch.value = 'main'; connectGithubRepo.value = ''; connectText.textContent = '检查接入'; connectBtn.classList.remove('partial');
    }
    const projectRuns = saved ? runs.filter(item => item.projectId === saved.id) : [];
    historyList.innerHTML = projectRuns.map((run, index) => { const meta = verdictMeta(run.execution?.verdict || (run.status === 'queued' ? 'queued' : run.status === 'failed' ? 'failed' : 'evidence_insufficient')); return `<article class="${index === 0 ? 'current' : ''}" data-run-id="${run.id}"><i></i><div><header><b>${run.id.toUpperCase()}</b><time>${new Date(run.createdAt).toLocaleString('zh-CN')}</time></header><h3>${escapeHtml(run.requirement)}</h3><p>${run.criteria.length} 条标准 · 第 ${run.attemptNumber || 1} 次 · ${meta.label}</p><span class="history-status ${run.execution?.verdict === 'passed' ? 'pass-status' : run.execution?.verdict === 'failed' || run.status === 'failed' ? 'fail-status' : 'hold-status'}">${meta.label}</span><button class="open-run-detail" data-run-id="${run.id}">查看真实任务</button></div></article>`; }).join('') || '<div class="contract-empty">还没有验收记录</div>';
    const summary = document.querySelectorAll('.history-summary b'); if (summary.length === 3) { summary[0].textContent = projectRuns.length; summary[1].textContent = projectRuns.filter(item => item.status !== 'completed').length; summary[2].textContent = projectRuns.filter(item => item.execution?.verdict === 'passed').length; }
    historyBtn.querySelector('span').textContent = String(projectRuns.length);
    backendRunId = requestedRun && requestedRun.projectId === saved?.id ? requestedRun.id : projectRuns[0]?.id || null;
    renderLiveDashboard(saved, projectRuns[0]);
    renderProjectMenu();
    await loadInbox();
    if (requestedRun && requestedRun.projectId === saved?.id) { backendRunId = requestedRun.id; history.replaceState({}, '', location.pathname); await loadRunTask(); }
    else if (query.has('project')) history.replaceState({}, '', location.pathname);
    if (!saved && !sessionStorage.getItem('shipwitness.starter.dismissed')) openStarter().catch(error => toast(error.message));
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
    renderRepositoryStatus(project.repositoryStatus || null, project.githubRepo);
    await loadContracts({ seed: true });
    connectText.textContent = '后端已保存';
    connectBtn.classList.add('partial');
    toggleConnect(false);
    toast('项目配置已保存到后端');
  } catch (error) { toast(error.message); }
};

const repositoryStateLabel = value => ({ success: 'CI 通过', failure: 'CI 失败', pending: 'CI 运行中', none: '暂无 CI 结果' }[value] || '状态未知');
function renderRepositoryStatus(status, repository = backendProject?.githubRepo) {
  syncRepository.disabled = !backendProjectId || !repository || !['owner', 'approver'].includes(currentSession?.role);
  syncRepository.hidden = currentSession?.role === 'member';
  if (!repository) { repositoryStatus.innerHTML = '<p>尚未配置 GitHub 仓库。令牌只从服务端环境读取，不会保存到项目或浏览器。</p>'; return; }
  if (!status) { repositoryStatus.innerHTML = `<p><b>${escapeHtml(repository)}</b> 尚未同步；管理员或审批人同步后，新任务会绑定当前提交。</p>`; return; }
  const tone = status.checks.state === 'success' ? 'success' : status.checks.state === 'failure' ? 'failure' : 'pending';
  repositoryStatus.innerHTML = `<article class="${tone}"><div><span>${escapeHtml(status.repository)} · ${escapeHtml(status.branch)}</span><b>${escapeHtml(status.commit.message || '无提交说明')}</b><p><a href="${escapeHtml(status.commit.url)}" target="_blank" rel="noopener">${escapeHtml(status.commit.shortSha)}</a> · ${escapeHtml(status.commit.author)}${status.commit.verified ? ' · 已验证签名' : ''}</p></div><em>${repositoryStateLabel(status.checks.state)}</em></article><small>${status.checks.passed}/${status.checks.total} 项通过 · ${status.checks.failed} 项失败 · ${status.checks.pending} 项进行中 · ${new Date(status.syncedAt).toLocaleString('zh-CN')} 同步</small>`;
}
async function loadRepositoryStatus() {
  if (!backendProjectId) return renderRepositoryStatus(null, '');
  try { const result = await api(`/api/projects/${backendProjectId}/repository`); renderRepositoryStatus(result.status, result.repository); }
  catch (error) { repositoryStatus.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
}
syncRepository.onclick = async () => {
  syncRepository.disabled = true; syncRepository.textContent = '同步中…';
  try { const status = await api(`/api/projects/${backendProjectId}/repository/sync`, { method: 'POST' }); backendProject.repositoryStatus = status; renderRepositoryStatus(status); toast(`已绑定提交 ${status.commit.shortSha}`); }
  catch (error) { toast(error.message); }
  finally { syncRepository.textContent = '同步仓库'; syncRepository.disabled = false; }
};
connectBtn.addEventListener('click', () => loadRepositoryStatus());

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
    const names = ['repo', 'url', 'browser', 'credentials', 'handoff'];
    names.forEach(name => {
      const item = document.querySelector(`[data-check="${name}"]`);
      const check = result.checks[name];
      item.className = check.status === 'ready' ? 'ready' : check.status === 'warning' ? 'warning' : 'failed';
      item.querySelector('p').textContent = check.detail;
      item.querySelector('em').textContent = check.status === 'ready' ? '已就绪' : check.status === 'warning' ? '注意' : '未通过';
    });
    const ready = Object.values(result.checks).filter(item => item.status === 'ready').length;
    preflightSummary.innerHTML = `<b>${ready} 项就绪</b> · 后端真实检查`;
    connectText.textContent = `接入 ${ready}/${names.length}`;
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

newRunBtn.onclick = () => {
  if (!backendProjectId || !backendProject) return openStarter().catch(error => toast(error.message));
  runProject.value = backendProject.name;
  runUrl.value = backendProject.url;
  runRepo.value = backendProject.repo;
  runRequirement.value = '';
  showRunStep(1);
  runDialog.showModal();
  runRequirement.focus();
};

const toggleContracts = open => { contractsPanel.classList.toggle('open', open); contractsPanel.setAttribute('aria-hidden', String(!open)); contractsMask.hidden = !open; };
contractsBtn.onclick = async () => { try { await loadContracts(); toggleContracts(true); } catch (error) { toast(error.message); } };
closeContracts.onclick = () => toggleContracts(false);
contractsMask.onclick = () => toggleContracts(false);
let pendingContractPack = null;
const resetContractAssets = () => { pendingContractPack = null; contractPackFile.value = ''; contractImportPreview.textContent = '选择来源后先预览，不会立即修改数据。'; contractImportPreview.className = 'asset-preview-result'; applyContractImport.disabled = true; };
contractAssetsBtn.onclick = () => {
  resetContractAssets();
  contractSourceProject.innerHTML = `<option value="">选择来源项目</option>${backendProjects.filter(item => item.id !== backendProjectId).map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
  contractAssetsDialog.showModal();
};
closeContractAssets.onclick = cancelContractAssets.onclick = () => contractAssetsDialog.close();
const contractImportPayload = async () => {
  if (contractPackFile.files[0]) {
    let parsed; try { parsed = JSON.parse(await contractPackFile.files[0].text()); } catch { throw new Error('JSON 文件格式无效'); }
    const contracts = Array.isArray(parsed) ? parsed : parsed.contracts;
    if (!Array.isArray(contracts)) throw new Error('文件中没有 contracts 标准列表');
    return { projectId: backendProjectId, contracts };
  }
  if (contractSourceProject.value) return { projectId: backendProjectId, sourceProjectId: contractSourceProject.value };
  throw new Error('请选择来源项目或 JSON 标准包');
};
previewContractImport.onclick = async () => {
  previewContractImport.disabled = true;
  try { pendingContractPack = await contractImportPayload(); const preview = await api('/api/contracts/import/preview', { method: 'POST', body: JSON.stringify(pendingContractPack) }); contractImportPreview.innerHTML = `<b>${preview.total} 条标准</b><span>${preview.create} 条新增${preview.conflicts.length ? ` · ${preview.conflicts.length} 条编号冲突：${preview.conflicts.map(escapeHtml).join('、')}` : ' · 没有编号冲突'}</span>`; contractImportPreview.className = `asset-preview-result ${preview.conflicts.length ? 'warning' : 'ready'}`; applyContractImport.disabled = false; }
  catch (error) { pendingContractPack = null; applyContractImport.disabled = true; contractImportPreview.textContent = error.message; contractImportPreview.className = 'asset-preview-result error'; }
  finally { previewContractImport.disabled = false; }
};
contractSourceProject.onchange = () => { contractPackFile.value = ''; pendingContractPack = null; applyContractImport.disabled = true; };
contractPackFile.onchange = () => { contractSourceProject.value = ''; pendingContractPack = null; applyContractImport.disabled = true; };
contractAssetsForm.onsubmit = async event => {
  event.preventDefault(); if (!pendingContractPack) return;
  applyContractImport.disabled = true;
  try { const result = await api('/api/contracts/import', { method: 'POST', body: JSON.stringify({ ...pendingContractPack, conflictMode: contractConflictMode.value }) }); await loadContracts(); contractAssetsDialog.close(); toast(`标准导入完成：新增 ${result.created}，更新 ${result.replaced}，跳过 ${result.skipped}`); }
  catch (error) { contractImportPreview.textContent = error.message; contractImportPreview.className = 'asset-preview-result error'; applyContractImport.disabled = false; }
};
contractAssetsDialog.querySelectorAll('[data-bulk-contracts]').forEach(button => { button.onclick = async () => { try { const enabled = button.dataset.bulkContracts === 'true'; const result = await api('/api/contracts/bulk', { method: 'PATCH', body: JSON.stringify({ projectId: backendProjectId, enabled }) }); await loadContracts(); toast(`${result.count} 条标准已${enabled ? '启用' : '停用'}`); } catch (error) { toast(error.message); } }; });
exportContractPack.onclick = async () => { try { const pack = await api(`/api/contracts/export?projectId=${encodeURIComponent(backendProjectId)}`); const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `ShipWitness-contracts-${backendProject.name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); toast(`已导出 ${pack.contracts.length} 条标准`); } catch (error) { toast(error.message); } };
const stepOptions = [['goto', '打开路径'], ['click', '点击元素'], ['fill', '填写内容'], ['expectVisible', '检查可见'], ['expectText', '检查文字'], ['expectUrl', '检查网址']];
const renderStepRows = steps => {
  contractSteps.innerHTML = steps.map((step, index) => `<div class="step-row"><span>${index + 1}</span><select class="step-action">${stepOptions.map(([value, label]) => `<option value="${value}" ${step.action === value ? 'selected' : ''}>${label}</option>`).join('')}</select><input class="step-target" value="${escapeHtml(step.path || step.selector || (step.action === 'expectUrl' ? step.value : ''))}" placeholder="路径或元素定位"><input class="step-value" list="acceptanceSecretRefs" value="${escapeHtml(step.action === 'expectUrl' ? '' : step.secretRef ? `{{secret:${step.secretRef}}}` : step.value || '')}" placeholder="普通内容或 {{secret:LOGIN_PASSWORD}}"><button type="button" class="remove-step" aria-label="删除步骤">×</button></div>`).join('') || '<p class="step-empty">尚未配置步骤，执行时会标记为“证据不足”。</p>';
};
const collectSteps = () => [...contractSteps.querySelectorAll('.step-row')].map(row => {
  const action = row.querySelector('.step-action').value;
  const target = row.querySelector('.step-target').value.trim();
  const value = row.querySelector('.step-value').value;
  if (action === 'goto') return { action, path: target };
  if (action === 'expectUrl') return { action, value: target };
  if (action === 'fill') { const secret = value.match(/^\{\{secret:([A-Z][A-Z0-9_]{1,63})\}\}$/); return secret ? { action, selector: target, secretRef: secret[1] } : { action, selector: target, value }; }
  if (action === 'expectText') return { action, selector: target, value };
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
    if (setup.needsSetup) return showAuth('setup', setup);
    const reset = new URLSearchParams(location.search).get('reset');
    if (reset) { try { return showPasswordReset(await api(`/api/password-reset/${reset}`), reset); } catch (error) { toast(error.message); history.replaceState({}, '', location.pathname); } }
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

async function downloadRunDossier() {
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
}
exportBtn.onclick = () => downloadRunDossier();
