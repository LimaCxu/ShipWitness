import assert from 'node:assert/strict';
import test from 'node:test';
import { createSigningKey, decryptSecret, encryptSecret, signPayload, verifySignedPayload } from '../lib/signing.js';
import { assertRollbackImage, rollbackCommands, rotateEncryptedSecrets } from '../lib/operations.js';

test('master-key rotation re-encrypts all material without changing plaintext', () => {
  const oldSecret = Buffer.alloc(32, 3).toString('base64'); const newSecret = Buffer.alloc(32, 4).toString('base64');
  const data = { workspaces: [{ id: 'ws_1', signingKey: createSigningKey(oldSecret) }], webhooks: [{ id: 'wh_1', workspaceId: 'ws_1', encryptedSecret: encryptSecret('whsec_value', oldSecret) }], emailDeliveries: [{ id: 'eml_1', workspaceId: 'ws_1', encryptedMessage: encryptSecret('{"subject":"test"}', oldSecret) }] };
  const payload = { runId: 'run_1', verdict: 'passed' }; const before = signPayload(payload, data.workspaces[0].signingKey, oldSecret);
  const oldSigningCiphertext = data.workspaces[0].signingKey.encryptedPrivateKey;
  assert.deepEqual(rotateEncryptedSecrets(data, oldSecret, newSecret), { workspaces: 1, webhooks: 1, emailDeliveries: 1 });
  assert.notEqual(data.workspaces[0].signingKey.encryptedPrivateKey, oldSigningCiphertext);
  assert.equal(decryptSecret(data.webhooks[0].encryptedSecret, newSecret), 'whsec_value');
  assert.equal(decryptSecret(data.emailDeliveries[0].encryptedMessage, newSecret), '{"subject":"test"}');
  assert.throws(() => decryptSecret(data.webhooks[0].encryptedSecret, oldSecret));
  assert.equal(verifySignedPayload(payload, before), true);
  assert.equal(verifySignedPayload(payload, signPayload(payload, data.workspaces[0].signingKey, newSecret)), true);
});

test('master-key rotation fails before mutation when any ciphertext is invalid', () => {
  const oldSecret = Buffer.alloc(32, 5).toString('base64'); const newSecret = Buffer.alloc(32, 6).toString('base64');
  const data = { workspaces: [{ id: 'ws_1', signingKey: createSigningKey(oldSecret) }], webhooks: [{ id: 'wh_bad', encryptedSecret: 'broken' }] };
  const original = structuredClone(data);
  assert.throws(() => rotateEncryptedSecrets(data, oldSecret, newSecret));
  assert.deepEqual(data, original);
});

test('rollback requires a non-latest image matching the backup version', () => {
  assert.equal(assertRollbackImage('registry.example.com/shipwitness:0.4.0-dev.6', '0.4.0-dev.6'), 'registry.example.com/shipwitness:0.4.0-dev.6');
  assert.throws(() => assertRollbackImage('shipwitness:latest', '0.4.0-dev.6'), /latest/);
  assert.throws(() => assertRollbackImage('shipwitness:0.4.0-dev.5', '0.4.0-dev.6'), /不一致/);
  const commands = rollbackCommands({ image: 'shipwitness:0.4.0-dev.6', backupFolder: '/safe/backup' });
  assert.deepEqual(commands[1], ['docker', 'compose', 'stop', 'shipwitness']);
  assert.ok(commands[2].includes('/safe/backup:/rollback-backup:ro'));
});
