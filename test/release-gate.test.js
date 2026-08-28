import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAudit } from '../lib/audit.js';
import { evaluateReleaseGate } from '../lib/release-gate.js';

const approvedGate = checksState => {
  const data = { auditEvents: [] };
  appendAudit(data, { workspaceId: 'ws_1', action: 'run.created', entityType: 'run', entityId: 'run_1' });
  const run = { id: 'run_1', status: 'completed', execution: { verdict: 'passed' }, repositorySnapshot: checksState ? { checks: { state: checksState } } : null };
  const decisions = [{ runId: 'run_1', verdict: 'approve', createdAt: '2026-08-28T00:00:00Z' }];
  return evaluateReleaseGate({ run, decisions, auditEvents: data.auditEvents });
};

test('release gate blocks a bound commit until its CI succeeds', () => {
  assert.equal(approvedGate('failure').status, 'blocked');
  assert.match(approvedGate('failure').reasons.join(' '), /CI 不是 success/);
  assert.equal(approvedGate('pending').status, 'blocked');
  assert.equal(approvedGate('none').status, 'blocked');
  assert.equal(approvedGate('success').status, 'pass');
  assert.equal(approvedGate(null).status, 'pass');
});
