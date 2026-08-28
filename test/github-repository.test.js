import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGitHubRepository, readGitHubRepository } from '../lib/github-repository.js';

test('GitHub repository reader uses fixed API routes and combines statuses with check runs', async () => {
  const sha = 'a'.repeat(40); const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/branches/feature%2Frelease')) return Response.json({ name: 'feature/release', commit: { sha, html_url: `https://github.com/acme/app/commit/${sha}`, commit: { message: 'Release candidate\nbody', author: { name: 'Ada', date: '2026-08-28T00:00:00Z' }, verification: { verified: true } } } });
    if (url.endsWith(`/commits/${sha}/status`)) return Response.json({ statuses: [{ state: 'success' }] });
    if (url.includes('/check-runs?')) return Response.json({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }] });
    return Response.json({ message: 'unexpected' }, { status: 404 });
  };
  const result = await readGitHubRepository({ repository: 'acme/app', branch: 'feature/release', token: 'server-only-token', fetcher });
  assert.equal(result.commit.sha, sha);
  assert.equal(result.commit.message, 'Release candidate');
  assert.equal(result.commit.verified, true);
  assert.deepEqual(result.checks, { state: 'pending', total: 3, passed: 2, failed: 0, pending: 1, detailsUrl: `https://github.com/acme/app/commit/${sha}/checks` });
  assert.ok(requests.every(item => item.url.startsWith('https://api.github.com/repos/acme/app/')));
  assert.ok(requests.every(item => item.options.headers.authorization === 'Bearer server-only-token'));
  assert.equal(JSON.stringify(result).includes('server-only-token'), false);
});

test('GitHub repository names are strictly validated', () => {
  assert.equal(normalizeGitHubRepository('acme/app'), 'acme/app');
  assert.equal(normalizeGitHubRepository('', { optional: true }), '');
  assert.throws(() => normalizeGitHubRepository('https://github.com/acme/app'), /owner\/repository/);
  assert.throws(() => normalizeGitHubRepository('../metadata'), /owner\/repository/);
});
