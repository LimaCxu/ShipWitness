const $ = id => document.getElementById(id);
function toast(text) { $('toast').textContent = text; $('toast').classList.add('show'); setTimeout(() => $('toast').classList.remove('show'), 2200); }
$('plainBtn').onclick = () => toast('创建并执行验收任务后，这里会解释真实结果');
$('evidenceBtn').onclick = () => toast('当前还没有可查看的原始证据');
$('closeDrawer').onclick = () => { $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); };
$('honestyBtn').onclick = () => { const hidden = $('honestyList').hidden; $('honestyList').hidden = !hidden; $('honestyBtn').querySelector('span').textContent = hidden ? '−' : '+'; };
$('decideBtn').onclick = () => toggleConnect(true);
$('exportBtn').onclick = () => toast('创建验收任务后可以导出卷宗');

// Prototype-only acceptance setup flow. It is intentionally labelled as simulated.
document.body.insertAdjacentHTML('beforeend',`<dialog id="newRunDialog" class="run-dialog"><form class="run-sheet" id="runForm">
  <header class="run-head"><div><span class="simulation-badge">真实任务配置</span><h2>新建一次发布验收</h2><p>先把“什么算完成”说清楚，再创建验收任务。</p></div><button type="button" class="run-close" id="closeRun" aria-label="关闭">×</button></header>
  <div class="step-rail" aria-label="创建步骤"><span class="is-current" data-step-dot="1"><b>1</b>项目信息</span><i></i><span data-step-dot="2"><b>2</b>验收标准</span><i></i><span data-step-dot="3"><b>3</b>确认执行</span></div>
  <section class="run-step" data-run-step="1"><div class="form-grid"><label><span>当前项目</span><input id="runProject" readonly></label><label><span>测试网址</span><input id="runUrl" type="url" readonly></label><label class="full"><span>项目目录</span><input id="runRepo" readonly></label><label class="full"><span>这次发布要证明什么？</span><textarea id="runRequirement" rows="4" required placeholder="例如：新登录流程可以正常登录，退出后无法再访问受保护页面。"></textarea><small>请写用户能观察到的业务结果；下一步选择用哪些标准验证。</small></label></div></section>
  <section class="run-step" data-run-step="2" hidden><div class="criteria-intro"><div><span>根据原始需求生成</span><h3>请确认验收标准</h3></div><button type="button" id="addCriterion">＋ 添加一条</button></div><div class="criteria-list" id="criteriaList">
    <label><input type="checkbox" checked><span><b>权限隔离</b><small>普通成员看不到管理入口，也不能通过网址直接进入后台。</small></span><em>SEC-01</em></label>
    <label><input type="checkbox" checked><span><b>资料保存</b><small>出现“保存成功”后刷新页面，新资料仍然存在。</small></span><em>DATA-02</em></label>
    <label><input type="checkbox" checked><span><b>删除客户</b><small>管理员可以删除客户，但恢复方式尚未定义。</small></span><em>DEL-01</em></label>
    <label><input type="checkbox" checked><span><b>安全退出</b><small>退出后访问受保护页面，必须返回登录页。</small></span><em>AUTH-01</em></label>
  </div><p class="criteria-note">黄色缺口不会被系统猜测，会在验收中交还给你决定。</p></section>
  <section class="run-step" data-run-step="3" hidden><div class="run-summary"><span class="simulation-badge">真实任务快照</span><h3 id="summaryProject">—</h3><dl><div><dt>测试地址</dt><dd id="summaryUrl"></dd></div><div><dt>关键路径</dt><dd id="summaryCriteria">0 条</dd></div><div><dt>任务状态</dt><dd>创建后等待你执行验收</dd></div></dl><div class="boundary"><b>证据边界</b><p>任务会保存当前标准快照。只有配置了浏览器步骤和断言的标准才能产生通过结论；其余保持“证据不足”。</p></div></div></section>
  <footer class="run-footer"><button type="button" class="secondary" id="runBack" hidden>上一步</button><span></span><button type="button" class="primary" id="runNext">下一步</button></footer>
</form></dialog>`);

let runStep=1;
const runDialog=$('newRunDialog');
function showRunStep(step){runStep=step;document.querySelectorAll('[data-run-step]').forEach(x=>x.hidden=Number(x.dataset.runStep)!==step);document.querySelectorAll('[data-step-dot]').forEach(x=>{const n=Number(x.dataset.stepDot);x.classList.toggle('is-current',n===step);x.classList.toggle('is-done',n<step)});$('runBack').hidden=step===1;$('runNext').textContent=step===3?'创建验收任务':'下一步';if(step===3){$('summaryProject').textContent=$('runProject').value;$('summaryUrl').textContent=$('runUrl').value;$('summaryCriteria').textContent=`${document.querySelectorAll('#criteriaList input:checked').length} 条`}}
$('newRunBtn').onclick=()=>{showRunStep(1);runDialog.showModal()};$('closeRun').onclick=()=>runDialog.close();$('runBack').onclick=()=>showRunStep(runStep-1);
$('addCriterion').onclick=()=>{const label=document.createElement('label');label.innerHTML='<input type="checkbox" checked><span><b contenteditable="true">新增标准</b><small contenteditable="true">点击这里描述用户可观察到的正确结果。</small></span><em>NEW</em>';$('criteriaList').append(label);label.querySelector('b').focus()};
$('runNext').onclick=async()=>{if(runStep===1&&!$('runForm').reportValidity())return;if(runStep<3){showRunStep(runStep+1);return}if(!document.querySelectorAll('#criteriaList input:checked').length)return toast('至少选择一条验收标准');$('runNext').disabled=true;$('runNext').textContent='创建中…';try{const run=await window.shipwitnessCreateRun();runDialog.close();document.querySelector('.case-id b').textContent=run.id.toUpperCase();$('nextAction').innerHTML='<span class="mini-label">任务已创建</span><h3>开始收集真实证据</h3><p>标准快照已经保存。进入任务详情后执行浏览器路径。</p><button class="decide" id="viewQueueBtn">打开任务并执行 <span>→</span></button>';$('viewQueueBtn').onclick=()=>document.querySelector(`[data-run-id="${run.id}"] .open-run-detail`)?.click();toast('验收任务已保存到后端')}catch(error){toast(error.message)}finally{$('runNext').disabled=false;$('runNext').textContent='创建验收任务'}};

document.body.insertAdjacentHTML('beforeend',`<dialog id="issueDialog" class="issue-dialog"><section class="issue-sheet">
  <header class="issue-head"><div><span class="issue-code" id="issueCode">—</span><span class="issue-state" id="issueState">待创建</span><h2 id="issueTitle">真实证据返工单</h2><p>返工内容直接来自本次验收标准和失败证据，可创建定向复验任务。</p></div><button class="run-close" id="closeIssue" aria-label="关闭">×</button></header>
  <div class="issue-layout"><main><section><span class="field-label">验收标准</span><p id="issueContract"></p></section><section><span class="field-label">如何复现</span><ol id="issueSteps"></ol></section><div class="actual-grid"><section><span class="field-label">实际结果</span><p id="issueActual"></p></section><section><span class="field-label">正确结果</span><p id="issueExpected"></p></section></div><section class="handoff-copy"><span class="field-label">交给编码 AI 的任务</span><p id="issuePrompt"></p></section></main><aside><span class="field-label">处理信息</span><dl><div><dt>严重程度</dt><dd class="severity" id="issueSeverity">—</dd></div><div><dt>证据</dt><dd id="issueEvidence">真实执行记录</dd></div><div><dt>处理方式</dt><dd id="issueHandoffMode">保存返工单</dd></div><div><dt>复验范围</dt><dd>当前失败路径</dd></div></dl><button id="handoffIssue">创建返工单</button><button id="downloadHandoff" class="secondary" hidden>下载 Agent 交接包</button><button id="exportGithub" class="secondary" hidden>创建 GitHub Issue</button><button id="retestIssue" class="secondary" hidden>创建定向复验</button><small id="issueHint">创建后会进入项目验收卷宗。</small></aside></div>
</section></dialog>
<aside class="history-panel" id="historyPanel" aria-hidden="true"><header><div><span>项目时间线</span><h2>验收历史</h2></div><button id="closeHistory" aria-label="关闭">×</button></header><div class="history-summary"><div><b>0</b><span>验收记录</span></div><div><b>0</b><span>进行中</span></div><div><b>0</b><span>已通过任务</span></div></div><div class="history-list" id="historyList"><div class="contract-empty">正在读取真实验收记录…</div></div><footer id="historyFooter"><p>选择记录查看真实执行步骤和证据。</p><button id="rerunBtn" hidden>复验失败路径</button></footer></aside><div class="panel-mask" id="panelMask" hidden></div>`);

function openIssue(){if(window.shipwitnessOpenIssue)return window.shipwitnessOpenIssue();toast('请先执行真实验收')}
document.addEventListener('click',e=>{const btn=e.target.closest('.return-work');if(btn)openIssue()});$('closeIssue').onclick=()=>$('issueDialog').close();
function toggleHistory(open){$('historyPanel').classList.toggle('open',open);$('historyPanel').setAttribute('aria-hidden',String(!open));$('panelMask').hidden=!open}$('historyBtn').onclick=()=>toggleHistory(true);$('closeHistory').onclick=()=>toggleHistory(false);$('panelMask').onclick=()=>toggleHistory(false);
$('rerunBtn').onclick=()=>toast('请从返工单创建定向复验任务');

document.body.insertAdjacentHTML('beforeend',`<aside class="connect-panel" id="connectPanel" aria-hidden="true"><header><div><span>项目接入</span><h2>验收环境检查</h2><p>先确认工具看得到项目、进得去页面，也知道把问题交回哪里。</p></div><button id="closeConnect" aria-label="关闭">×</button></header>
  <section class="connect-form"><label><span>项目目录</span><input id="connectRepo" value="/Users/chenxu/Projects/demo"></label><label><span>测试网址</span><input id="connectUrl" type="url" value="http://localhost:3000"></label><div class="connect-row"><label><span>代码分支</span><input id="connectBranch" value="main"></label><label><span>返工交回方式</span><select id="handoffMode"><option value="file">生成本地返工单</option><option value="github">创建 GitHub Issue</option><option value="agent">生成编码 Agent 交接包</option><option value="manual">仅复制任务文本</option></select></label></div><label><span>GitHub 仓库（可选）</span><input id="connectGithubRepo" placeholder="owner/repository"><small>仅保存仓库名称；访问令牌必须通过服务端 GITHUB_TOKEN 配置。</small></label></section>
  <section class="preflight"><div class="preflight-head"><div><span class="field-label">配置检查</span><p id="preflightSummary">尚未检查</p></div><button id="runPreflight">运行检查</button></div><div class="check-list" id="checkList">
    <article data-check="repo"><i></i><div><b>项目目录可读取</b><p>确认路径存在，并能识别当前提交版本。</p></div><em>待检查</em></article>
    <article data-check="url"><i></i><div><b>测试网址可访问</b><p>确认页面响应且不是错误页。</p></div><em>待检查</em></article>
    <article data-check="browser"><i></i><div><b>浏览器可以执行路径</b><p>确认页面操作和证据截图能力可用。</p></div><em>待检查</em></article>
    <article data-check="handoff"><i></i><div><b>返工结果有去向</b><p>确认缺陷可以保存或交给编码 AI。</p></div><em>待检查</em></article>
  </div></section><section class="connect-boundary"><b>当前连接真实执行服务</b><p>目录、Git 状态和测试网址由后端检查；配置浏览器步骤后，可执行真实点击、输入、断言和截图取证。</p></section><footer><button id="saveConnection" disabled>保存接入配置</button></footer></aside><div class="connect-mask" id="connectMask" hidden></div>`);

function toggleConnect(open){$('connectPanel').classList.toggle('open',open);$('connectPanel').setAttribute('aria-hidden',String(!open));$('connectMask').hidden=!open}
$('connectBtn').onclick=()=>toggleConnect(true);$('closeConnect').onclick=()=>toggleConnect(false);$('connectMask').onclick=()=>toggleConnect(false);
