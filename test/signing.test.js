import test from 'node:test';
import assert from 'node:assert/strict';
import { createSigningKey, signPayload, verifySignedPayload } from '../lib/signing.js';

test('Ed25519 dossier signature verifies offline and detects payload changes', () => {
  const secret = Buffer.alloc(32, 9).toString('base64');
  const key = createSigningKey(secret);
  const payload = { schema: 'shipwitness.dossier.v2', run: { id: 'run_signed', verdict: 'passed' }, auditProof: { valid: true, headHash: 'abc' } };
  const signature = signPayload(payload, key, secret);
  assert.equal(verifySignedPayload(payload, signature), true);
  payload.run.verdict = 'failed';
  assert.equal(verifySignedPayload(payload, signature), false);
  assert.doesNotMatch(key.encryptedPrivateKey, /PRIVATE KEY/);
});
