import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fetchTarget, targetOrigins, validateTargetUrl } from '../lib/target-policy.js';

test('target policy allows loopback and explicit origins only', () => {
  assert.equal(validateTargetUrl('http://127.0.0.1:4173/path').origin, 'http://127.0.0.1:4173');
  assert.equal(validateTargetUrl('http://[::1]:4173/path').origin, 'http://[::1]:4173');
  assert.equal(validateTargetUrl('https://staging.example.com/app', ['https://staging.example.com']).pathname, '/app');
  assert.throws(() => validateTargetUrl('https://metadata.example.test/'), /未获管理员允许/);
  assert.throws(() => validateTargetUrl('https://user:secret@staging.example.com/', ['https://staging.example.com']), /无凭据/);
  assert.deepEqual(targetOrigins('https://one.example,https://one.example/,http://two.example:8080'), ['https://one.example', 'http://two.example:8080']);
});

test('target fetch rejects a redirect before contacting an unapproved origin', async t => {
  const server = http.createServer((req, res) => { res.writeHead(302, { location: 'https://unapproved.example.test/private' }); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(fetchTarget(`http://127.0.0.1:${server.address().port}/`), /未获管理员允许/);
});
