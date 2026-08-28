import { createHash, randomUUID } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function appendAudit(data, { workspaceId, actorUserId = null, action, entityType, entityId, details = {}, at = new Date().toISOString() }) {
  data.auditEvents ||= [];
  const previous = data.auditEvents.filter(item => item.workspaceId === workspaceId).sort((a, b) => b.sequence - a.sequence)[0];
  const event = { id: `audit_${randomUUID().slice(0, 8)}`, workspaceId, sequence: (previous?.sequence || 0) + 1, previousHash: previous?.hash || null, actorUserId, action, entityType, entityId, details, at };
  event.hash = digest(event);
  data.auditEvents.push(event);
  return event;
}

export function verifyAuditChain(events) {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  let previousHash = null;
  for (let index = 0; index < ordered.length; index += 1) {
    const event = ordered[index]; const { hash, ...unsigned } = event;
    if (event.sequence !== index + 1 || event.previousHash !== previousHash || digest(unsigned) !== hash) return { valid: false, checked: index, brokenEventId: event.id };
    previousHash = hash;
  }
  return { valid: true, checked: ordered.length, headHash: previousHash };
}
