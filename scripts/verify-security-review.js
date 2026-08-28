import { readFile } from 'node:fs/promises';
import { verifySignedPayload } from '../lib/signing.js';

const file = process.argv[2];
if (!file) { console.error('用法：npm run security-review:verify -- <签名安全整改证据包.json>'); process.exit(2); }
try {
  const document = JSON.parse(await readFile(file, 'utf8'));
  const valid = document.schema === 'shipwitness.signed-security-review.v1' && document.payload?.schema === 'shipwitness.security-review.v1' && verifySignedPayload(document.payload, document.signature);
  console.log(JSON.stringify({ valid, dossierId: document.id || null, reviewId: document.payload?.review?.id || null, reference: document.payload?.review?.reference || null, findings: document.payload?.summary?.total ?? null, unresolved: document.payload?.summary?.unresolved ?? null }, null, 2)); process.exit(valid ? 0 : 1);
} catch (error) { console.error(JSON.stringify({ valid: false, error: error.message })); process.exit(2); }
