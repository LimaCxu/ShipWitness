import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubWebhook({ raw, signature, secret }) {
  if (!secret) throw Object.assign(new Error('GitHub Webhook 尚未配置'), { status: 503 });
  if (!/^sha256=[a-f0-9]{64}$/i.test(String(signature || ''))) throw Object.assign(new Error('GitHub Webhook 签名缺失或格式无效'), { status: 401 });
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const supplied = String(signature).toLowerCase();
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw Object.assign(new Error('GitHub Webhook 签名无效'), { status: 401 });
  return true;
}

export function githubWebhookTarget(event, payload) {
  const repository = String(payload?.repository?.full_name || '').trim();
  let branch = null;
  if (event === 'push') branch = String(payload?.ref || '').replace(/^refs\/heads\//, '');
  if (event === 'check_suite') branch = payload?.check_suite?.head_branch || null;
  if (event === 'check_run') branch = payload?.check_run?.check_suite?.head_branch || payload?.check_run?.pull_requests?.[0]?.head?.ref || null;
  if (event === 'workflow_run') branch = payload?.workflow_run?.head_branch || null;
  return { repository, branch: branch ? String(branch) : null, supported: ['push', 'check_suite', 'check_run', 'workflow_run'].includes(event) };
}
