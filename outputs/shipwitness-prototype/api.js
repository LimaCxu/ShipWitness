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

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
const defaultContracts = [
  { code: 'AUTH-01', title: '权限隔离', description: '普通成员看不到管理入口，也不能通过网址直接进入后台。', category: '权限', severity: 'blocker' },
  { code: 'DATA-01', title: '资料保存', description: '出现“保存成功”后刷新页面，新资料仍然存在。', category: '数据', severity: 'blocker' },
  { code: 'DELETE-01', title: '删除客户', description: '管理员可以删除客户，且删除后的恢复方式必须符合产品决定。', category: '业务流程', severity: 'major' },
  { code: 'SESSION-01', title: '安全退出', description: '退出后访问受保护页面，必须返回登录页。', category: '安全', severity: 'blocker' }
];

document.body.insertAdjacentHTML('beforeend', `<aside class="run-task-panel" id="runTaskPanel" aria-hidden="true"><header><div><span>真实任务</span><h2>验收执行详情</h2></div><button id="closeRunTask" aria-label="关闭">×</button></header><section class="run-task-state"><div><span id="runTaskId">—</span><strong id="runTaskStatus">等待读取</strong></div><p id="runTaskSummary">从后端读取任务状态和真实执行证据。</p></section><section class="system-evidence" id="systemEvidence"><div class="empty-task">尚未执行检查</div></section><section class="criteria-results"><span class="field-label">验收标准</span><div id="backendCriteria"></div></section><footer><p id="runTaskBoundary">只有配置了浏览器步骤和结果断言的标准才可能自动通过。</p><button id="executeRunBtn">执行验收</button></footer></aside><div class="run-task-mask" id="runTaskMask" hidden></div>`);
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
    verdictStage: { kicker: '证据裁决', title: verdictMeta(result.result).label, body: result.reason || verdictMeta(result.result).detail, visual: `<div class="verdict-card"><span>${result.result === 'passed' ? '验收通过' : result.result === 'failed' ? '验收失败' : '不作通过判断'}</span><strong>${verdictMeta(result.result).label}</strong><p>${escapeHtml(result.reason || verdictMeta(result.result).detail)}</p></div>` }
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
  if (overall === 'passed') nextAction.innerHTML = '<span class="mini-label">发布门槛已满足</span><h3>保存发布卷宗</h3><p>所有标准都有真实断言证据，可以记录负责人决定。</p><button class="decide" id="dashboardExport">导出真实卷宗 <span>→</span></button>';
  else if (overall === 'failed') nextAction.innerHTML = '<span class="mini-label">现在需要处理</span><h3>查看失败路径</h3><p>先核对截图和步骤，再生成返工单。</p><button class="decide" id="viewQueueBtn">查看任务证据 <span>→</span></button>';
  else if (run.status === 'queued') nextAction.innerHTML = '<span class="mini-label">任务已经就绪</span><h3>执行真实浏览器验收</h3><p>执行后保存步骤、网络响应和截图证据。</p><button class="decide" id="viewQueueBtn">打开任务并执行 <span>→</span></button>';
  else nextAction.innerHTML = '<span class="mini-label">证据仍不完整</span><h3>补齐浏览器步骤</h3><p>未配置步骤的标准不会被判定通过。</p><button class="decide" id="dashboardContracts">打开标准库 <span>→</span></button>';
  document.querySelector('#dashboardContracts')?.addEventListener('click', () => contractsBtn.click()); document.querySelector('#dashboardExport')?.addEventListener('click', () => downloadDossier.click());
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
      connectText.textContent = '后端已保存';
      connectBtn.classList.add('partial');
      await loadContracts({ seed: true });
    }
    const runs = await api('/api/runs');
    const projectRuns = saved ? runs.filter(item => item.projectId === saved.id) : [];
    historyList.innerHTML = projectRuns.map((run, index) => { const meta = verdictMeta(run.execution?.verdict || (run.status === 'queued' ? 'queued' : 'evidence_insufficient')); return `<article class="${index === 0 ? 'current' : ''}" data-run-id="${run.id}"><i></i><div><header><b>${run.id.toUpperCase()}</b><time>${new Date(run.createdAt).toLocaleString('zh-CN')}</time></header><h3>${escapeHtml(run.requirement)}</h3><p>${run.criteria.length} 条标准 · ${meta.label}</p><span class="history-status ${run.execution?.verdict === 'passed' ? 'pass-status' : run.execution?.verdict === 'failed' ? 'fail-status' : 'hold-status'}">${meta.label}</span><button class="open-run-detail" data-run-id="${run.id}">查看真实任务</button></div></article>`; }).join('') || '<div class="contract-empty">还没有验收记录</div>';
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
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: backendProjectId, name: document.querySelector('.project-head h1').childNodes[0].textContent.trim(), repo: connectRepo.value, url: connectUrl.value, branch: connectBranch.value, handoffMode: handoffMode.value }) });
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

bootstrapBackend();

const toggleRunTask = open => { runTaskPanel.classList.toggle('open', open); runTaskPanel.setAttribute('aria-hidden', String(!open)); runTaskMask.hidden = !open; };
const resultLabel = value => ({ ready: '已就绪', passed: '已通过', warning: '注意', failed: '未通过', blocked: '被阻断', evidence_insufficient: '证据不足' }[value] || value);
async function loadRunTask() {
  if (!backendRunId) return toast('还没有后端验收任务');
  const run = await api(`/api/runs/${backendRunId}`);
  renderLiveDashboard(backendProject, run);
  runTaskId.textContent = run.id.toUpperCase();
  runTaskStatus.textContent = run.status === 'completed' ? (run.execution?.executor === 'shipwitness-browser-v1' ? '真实验收已完成' : '基础检查已完成') : run.status === 'running' ? '正在执行' : '等待执行';
  runTaskSummary.textContent = run.execution?.summary || '任务已保存，尚未运行任何检查。';
  backendCriteria.innerHTML = (run.execution?.criteriaResults || run.criteria.map(item => ({ ...item, result: 'queued', reason: '等待执行器' }))).map(item => `<article><i class="${item.result}"></i><div><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.reason || item.description)}</p>${item.steps?.length ? `<small>${item.steps.filter(step => step.status === 'passed').length}/${item.steps.length} 步完成</small>` : ''}${item.screenshotUrl ? `<a href="${item.screenshotUrl}" target="_blank">查看截图证据 ↗</a>` : ''}</div><em>${resultLabel(item.result)}</em></article>`).join('');
  if (run.execution) {
    if (run.execution.executor === 'shipwitness-browser-v1') {
      const passed = run.execution.criteriaResults.filter(item => item.result === 'passed').length;
      const failed = run.execution.criteriaResults.filter(item => item.result === 'failed').length;
      systemEvidence.innerHTML = `<article><span>浏览器引擎</span><b>${run.execution.browser?.status === 'ready' ? 'Chromium 已执行' : '环境不可用'}</b><p>${escapeHtml(run.execution.browser?.error || '真实无头浏览器')}</p></article><article><span>业务断言</span><b>${passed} 条通过</b><p>${failed} 条失败 · ${run.criteria.length - passed - failed} 条证据不足</p></article><article><span>执行器</span><b>Browser v1</b><p>截图、步骤和网络响应已记录</p></article>`;
      runTaskBoundary.textContent = '真实浏览器只对有明确断言且全部成功的标准判定通过。';
      executeRunBtn.textContent = '重新执行真实验收';
    } else {
      const target = run.execution.target, repository = run.execution.repository;
      systemEvidence.innerHTML = `<article><span>项目目录</span><b>${resultLabel(repository.status)}</b><p>${repository.detail}</p></article><article><span>测试网址</span><b>HTTP ${target.httpStatus ?? '—'}</b><p>${target.title || target.error || target.finalUrl || '无标题'}</p></article><article><span>内容指纹</span><b>${target.contentSha256?.slice(0, 12) || '未生成'}</b><p>${target.durationMs} ms · 检查 ${target.bodyBytesInspected || 0} bytes</p></article>`;
      runTaskBoundary.textContent = '当前任务没有浏览器步骤，只执行了基础环境检查。';
      executeRunBtn.textContent = '重新执行基础检查';
    }
  } else {
    systemEvidence.innerHTML = '<div class="empty-task">尚未执行基础检查</div>';
    executeRunBtn.textContent = '执行基础检查';
  }
  toggleRunTask(true);
}
closeRunTask.onclick = () => toggleRunTask(false); runTaskMask.onclick = () => toggleRunTask(false);
document.addEventListener('click', event => { const trigger = event.target.closest('.open-run-detail') || event.target.closest('#viewQueueBtn'); if (trigger) { if (trigger.dataset.runId) backendRunId = trigger.dataset.runId; loadRunTask().catch(error => toast(error.message)); } });
executeRunBtn.onclick = async () => {
  executeRunBtn.disabled = true; executeRunBtn.textContent = '正在执行与取证…'; runTaskStatus.textContent = '正在执行';
  try { await api(`/api/runs/${backendRunId}/execute`, { method: 'POST' }); await loadRunTask(); toast('验收证据已保存到后端'); }
  catch (error) { toast(error.message); }
  finally { executeRunBtn.disabled = false; }
};

handoffIssue.onclick = async () => {
  if (!backendRunId) return toast('请先创建验收任务');
  const current = issueMap[selectedIssue] || issueMap.permissions;
  try {
    await api('/api/issues', { method: 'POST', body: JSON.stringify({ runId: backendRunId, title: current.title, contract: issueContract.textContent, actual: issueActual.textContent, expected: issueExpected.textContent }) });
    issueState.textContent = '已写入后端';
    issueState.classList.add('sent');
    handoffIssue.textContent = '已交回，等待修复';
    handoffIssue.disabled = true;
    toast('返工单已保存到后端');
  } catch (error) { toast(error.message); }
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
