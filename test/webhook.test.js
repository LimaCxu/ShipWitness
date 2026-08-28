import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { validateWebhookUrl, webhookSignature } from '../lib/webhook.js';

test('webhook signature covers the exact raw body', () => {
  const body = JSON.stringify({ event: 'release.decision', decision: 'approve' });
  const expected = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
  assert.equal(webhookSignature(body, 'test-secret'), expected);
  assert.notEqual(webhookSignature(`${body}\n`, 'test-secret'), expected);
});

test('webhook URL validation requires credential-free HTTPS', async () => {
  await assert.rejects(validateWebhookUrl('http://example.com/hook'), /HTTPS/);
  await assert.rejects(validateWebhookUrl('https://user:secret@example.com/hook'), /无凭据/);
  assert.equal(await validateWebhookUrl('https://127.0.0.1/hook', { allowPrivate: true }), 'https://127.0.0.1/hook');
});
