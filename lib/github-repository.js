const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeGitHubRepository(value, { optional = false } = {}) {
  const repository = String(value || '').trim();
  if (!repository && optional) return '';
  const parts = repository.split('/');
  if (!repositoryPattern.test(repository) || parts.some(part => part === '.' || part === '..')) throw Object.assign(new Error('GitHub 仓库格式应为 owner/repository'), { status: 400 });
  return repository;
}

const apiError = async response => {
  const payload = await response.json().catch(() => ({}));
  const status = response.status === 401 || response.status === 403 ? 502 : response.status === 404 ? 404 : 502;
  return Object.assign(new Error(payload.message || `GitHub 返回 HTTP ${response.status}`), { status });
};

const checkState = ({ statuses, checkRuns }) => {
  const failedConclusions = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']);
  const failed = statuses.filter(item => ['failure', 'error'].includes(item.state)).length + checkRuns.filter(item => item.status === 'completed' && failedConclusions.has(item.conclusion)).length;
  const pending = statuses.filter(item => item.state === 'pending').length + checkRuns.filter(item => item.status !== 'completed').length;
  const passed = statuses.filter(item => item.state === 'success').length + checkRuns.filter(item => item.status === 'completed' && ['success', 'neutral', 'skipped'].includes(item.conclusion)).length;
  const total = statuses.length + checkRuns.length;
  return { state: failed ? 'failure' : pending ? 'pending' : total && passed === total ? 'success' : 'none', total, passed, failed, pending };
};

export async function readGitHubRepository({ repository, branch, token, fetcher = fetch }) {
  const repo = normalizeGitHubRepository(repository);
  const ref = String(branch || '').trim();
  if (!ref || ref.length > 255 || /[\u0000-\u001f]/.test(ref)) throw Object.assign(new Error('代码分支无效'), { status: 400 });
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ShipWitness' };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = async path => {
    const response = await fetcher(`https://api.github.com/repos/${repo}${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers });
    if (!response.ok) throw await apiError(response);
    return response.json();
  };
  const branchData = await request(`/branches/${encodeURIComponent(ref)}`);
  const sha = branchData.commit?.sha;
  if (!/^[a-f0-9]{40}$/i.test(String(sha || ''))) throw Object.assign(new Error('GitHub 没有返回有效提交'), { status: 502 });
  const [statusData, checksData] = await Promise.all([request(`/commits/${sha}/status`), request(`/commits/${sha}/check-runs?filter=latest&per_page=100`)]);
  const statuses = Array.isArray(statusData.statuses) ? statusData.statuses : [];
  const checkRuns = Array.isArray(checksData.check_runs) ? checksData.check_runs : [];
  const checks = checkState({ statuses, checkRuns });
  return {
    provider: 'github', repository: repo, branch: branchData.name || ref,
    commit: { sha, shortSha: sha.slice(0, 7), url: `https://github.com/${repo}/commit/${sha}`, message: String(branchData.commit.commit?.message || '').split('\n')[0].slice(0, 500), author: String(branchData.commit.commit?.author?.name || branchData.commit.author?.login || '未知提交者').slice(0, 200), committedAt: branchData.commit.commit?.author?.date || null, verified: Boolean(branchData.commit.commit?.verification?.verified) },
    checks: { ...checks, detailsUrl: `https://github.com/${repo}/commit/${sha}/checks` },
    syncedAt: new Date().toISOString()
  };
}
