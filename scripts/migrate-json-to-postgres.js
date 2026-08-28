import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgresStore } from '../lib/postgres-store.js';

const source = resolve(process.argv[2] || process.env.SHIPWITNESS_STORE_FILE || 'data/store.json');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL 不能为空');

const incoming = JSON.parse(await readFile(source, 'utf8'));
const store = new PostgresStore(databaseUrl);
try {
  const current = await store.read();
  const collections = Object.keys(current);
  const existingCount = collections.reduce((total, name) => total + current[name].length, 0);
  if (existingCount && !process.argv.includes('--force')) throw new Error('目标数据库已有数据；如确认覆盖，请添加 --force');
  await store.update(data => {
    for (const name of collections) data[name] = Array.isArray(incoming[name]) ? incoming[name] : [];
  });
  const migrated = await store.read();
  const counts = Object.fromEntries(collections.map(name => [name, migrated[name].length]));
  console.log(JSON.stringify({ ok: true, source, counts }, null, 2));
} finally { await store.close(); }
