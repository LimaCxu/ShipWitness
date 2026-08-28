const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function buildHandoffPackage({ issue, run, project }) {
  const steps = issue.reproductionSteps?.length ? issue.reproductionSteps : ['按验收标准复现当前路径'];
  const prompt = [
    `修复返工单 ${issue.id}：${issue.title}`,
    '', '不得修改已确认的验收标准。',
    `验收标准：${issue.contract}`,
    `实际结果：${issue.actual}`,
    `正确结果：${issue.expected}`,
    '', '复现步骤：', ...steps.map((step, index) => `${index + 1}. ${step}`),
    '', `复验任务由 ShipWitness 针对标准 ${issue.code} 执行。`,
    '完成后请说明修改文件、运行方式和可能影响的相邻路径。'
  ].join('\n');
  return { schema: 'shipwitness.handoff.v1', issueId: issue.id, runId: run.id, projectId: project.id, branch: project.branch, code: issue.code, severity: issue.severity, title: issue.title, contract: issue.contract, actual: issue.actual, expected: issue.expected, reproductionSteps: steps, evidence: issue.evidence, prompt, generatedAt: new Date().toISOString() };
}

export async function createGitHubIssue({ repo, token, title, body, labels = ['shipwitness', 'acceptance-failure'] }) {
  if (!repoPattern.test(String(repo || ''))) throw Object.assign(new Error('GitHub 仓库格式应为 owner/repository'), { status: 400 });
  if (!token) throw Object.assign(new Error('尚未配置 GITHUB_TOKEN'), { status: 409 });
  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'ShipWitness' }, body: JSON.stringify({ title, body, labels }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message || `GitHub 返回 HTTP ${response.status}`), { status: response.status === 401 || response.status === 403 ? 502 : 400 });
  return { provider: 'github', id: String(payload.number), url: payload.html_url, repo };
}
