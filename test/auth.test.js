import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginThrottle } from '../lib/auth.js';

test('login throttle blocks repeated failures and resets after its time window', () => {
  let clock = 1_000;
  const throttle = createLoginThrottle({ maxAttempts: 3, windowMs: 10_000, now: () => clock });
  throttle.recordFailure('client:user'); throttle.recordFailure('client:user');
  assert.equal(throttle.check('client:user').blocked, false);
  const blocked = throttle.recordFailure('client:user');
  assert.equal(blocked.blocked, true); assert.equal(blocked.retryAfterSeconds, 10);
  clock += 9_001;
  assert.equal(throttle.check('client:user').retryAfterSeconds, 1);
  clock += 999;
  assert.deepEqual(throttle.check('client:user'), { blocked: false, retryAfterSeconds: 0 });
  throttle.recordFailure('client:user');
  assert.equal(throttle.check('client:user').blocked, false);
});

test('login throttle clears successful identities and bounds stale entries', () => {
  let clock = 0;
  const throttle = createLoginThrottle({ maxAttempts: 1, windowMs: 100, maxEntries: 2, now: () => clock });
  throttle.recordFailure('first'); throttle.clear('first');
  assert.equal(throttle.check('first').blocked, false);
  throttle.recordFailure('second'); clock = 101; throttle.recordFailure('third');
  assert.equal(throttle.size, 1);
});
