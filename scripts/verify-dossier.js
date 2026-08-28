import { readFile } from 'node:fs/promises';
import { verifySignedPayload } from '../lib/signing.js';

const file = process.argv[2];
if (!file) { console.error('用法：npm run dossier:verify -- <签名卷宗.json>'); process.exit(2); }
try {
  const document = JSON.parse(await readFile(file, 'utf8'));
  const valid = document.schema === 'shipwitness.signed-dossier.v1' && verifySignedPayload(document.payload, document.signature);
  console.log(JSON.stringify({ valid, dossierId: document.id || null, runId: document.payload?.run?.id || null }, null, 2)); process.exit(valid ? 0 : 1);
} catch (error) { console.error(JSON.stringify({ valid: false, error: error.message })); process.exit(2); }
