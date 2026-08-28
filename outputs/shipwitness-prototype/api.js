const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...options.headers }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
};

let backendProjectId = null;
let backendRunId = null;
let backendContracts = [];

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

async function bootstrapBackend() {
  try {
    await api('/api/health');
    setServiceState(true, '服务已连接');
    const projects = await api('/api/projects');
    const saved = projects[0];
    if (saved) {
      backendProjectId = saved.id;
      connectRepo.value = saved.repo;
      connectUrl.value = saved.url;
      connectBranch.value = saved.branch;
      handoffMode.value = saved.handoffMode;
      connectText.textContent = '后端已保存';
      connectBtn.classList.add('partial');
      await loadContracts({ seed: true });
    }
    const runs = await api('/api/runs');
    if (runs[0]) {
      backendRunId = runs[0].id;
      const existing = document.querySelector('#backendRunEntry');
      const statusLabel = runs[0].status === 'completed' ? (runs[0].execution?.executor === 'shipwitness-browser-v1' ? '真实验收完成' : '基础检查完成') : '等待执行';
      const markup = `<article id="backendRunEntry" class="current"><i></i><div><header><b>${runs[0].id.toUpperCase()}</b><time>后端记录</time></header><h3>${statusLabel}</h3><p>${runs[0].criteria.length} 条验收标准 · 状态 ${runs[0].status}</p><span class="history-status hold-status">${runs[0].execution?.verdict === 'evidence_insufficient' ? '证据不足' : '等待执行器'}</span><button class="open-run-detail">查看真实任务</button></div></article>`;
      existing ? existing.outerHTML = markup : historyList.insertAdjacentHTML('afterbegin', markup);
      historyBtn.querySelector('span').textContent = String(3 + runs.length);
    }
  } catch {
    setServiceState(false, '后端未启动');
  }
}

saveConnection.onclick = async () => {
  try {
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ id: backendProjectId, name: document.querySelector('.project-head h1').childNodes[0].textContent.trim(), repo: connectRepo.value, url: connectUrl.value, branch: connectBranch.value, handoffMode: handoffMode.value }) });
    backendProjectId = project.id;
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
document.addEventListener('click', event => { if (event.target.closest('.open-run-detail') || event.target.closest('#viewQueueBtn')) loadRunTask().catch(error => toast(error.message)); });
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
