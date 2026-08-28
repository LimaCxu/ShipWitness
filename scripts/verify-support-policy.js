import assert from 'node:assert/strict';
import { releaseSupportStatus, supportPolicy } from '../lib/support.js';

assert.equal(supportPolicy.schema, 'shipwitness.support-policy.v1');
assert.ok(supportPolicy.stableMinorSupportMonths >= 12);
assert.ok(supportPolicy.predecessorMinimumMonths >= 6);
assert.ok(supportPolicy.endOfSupportNoticeDays >= 90);
assert.equal(releaseSupportStatus({ version: '0.4.0-dev.24' }).status, 'evaluation_only');
assert.equal(releaseSupportStatus({ version: '1.0.0', releasedAt: '2026-01-01T00:00:00Z', endOfSupportAt: '2027-01-01T00:00:00Z', now: new Date('2026-06-01T00:00:00Z') }).status, 'supported');
assert.equal(releaseSupportStatus({ version: '1.0.0', releasedAt: '2026-01-01T00:00:00Z', endOfSupportAt: '2026-06-01T00:00:00Z', now: new Date('2026-02-01T00:00:00Z') }).status, 'support_window_too_short');
assert.equal(releaseSupportStatus({ version: '1.0.0', releasedAt: '2026-01-01T00:00:00Z', endOfSupportAt: '2027-01-01T00:00:00Z', now: new Date('2027-02-01T00:00:00Z') }).status, 'end_of_support');
console.log(JSON.stringify({ valid: true, policy: supportPolicy.schema }, null, 2));
