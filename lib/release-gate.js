import { verifyAuditChain } from './audit.js';

export function evaluateReleaseGate({ run, decisions, auditEvents }) {
  if (!run) return { status: 'error', exitCode: 2, reasons: ['验收任务不存在'] };
  const reasons = [];
  if (run.status !== 'completed') reasons.push('验收任务尚未完成');
  if (run.execution?.verdict !== 'passed') reasons.push(`证据裁决不是 passed：${run.execution?.verdict || 'missing'}`);
  const latestDecision = [...decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
  if (latestDecision?.verdict !== 'approve') reasons.push('尚无有效的批准发布决定');
  const auditProof = verifyAuditChain(auditEvents);
  if (!auditProof.valid) reasons.push(`审计链完整性校验失败：${auditProof.brokenEventId}`);
  return { status: reasons.length ? 'blocked' : 'pass', exitCode: reasons.length ? 1 : 0, reasons, runId: run.id, evidenceVerdict: run.execution?.verdict || null, approval: latestDecision, auditProof };
}
