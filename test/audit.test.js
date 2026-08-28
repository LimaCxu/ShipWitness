import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAudit, verifyAuditChain } from '../lib/audit.js';

test('audit chain detects changed historical details and missing sequence', () => {
  const data = { auditEvents: [] };
  appendAudit(data, { workspaceId: 'ws_1', actorUserId: 'usr_1', action: 'project.created', entityType: 'project', entityId: 'prj_1', details: { branch: 'main' }, at: '2026-01-01T00:00:00.000Z' });
  appendAudit(data, { workspaceId: 'ws_1', actorUserId: 'usr_1', action: 'run.created', entityType: 'run', entityId: 'run_1', at: '2026-01-01T00:01:00.000Z' });
  assert.equal(verifyAuditChain(data.auditEvents).valid, true);

  data.auditEvents[0].details.branch = 'tampered';
  const changed = verifyAuditChain(data.auditEvents);
  assert.equal(changed.valid, false);
  assert.equal(changed.brokenEventId, data.auditEvents[0].id);

  data.auditEvents.splice(0, 1);
  assert.equal(verifyAuditChain(data.auditEvents).valid, false);
});
