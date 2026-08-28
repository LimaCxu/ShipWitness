import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStore } from '../lib/postgres-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL store migrates, persists collections and rolls back failed mutations', { skip: !databaseUrl }, async () => {
  const store = new PostgresStore(databaseUrl);
  try {
    await store.ready();
    await store.update(data => { for (const name of Object.keys(data)) data[name] = []; });
    await store.update(data => {
      data.workspaces.push({ id: 'ws_postgres', name: 'PostgreSQL 验证', createdAt: new Date().toISOString() });
      data.projects.push({ id: 'prj_postgres', workspaceId: 'ws_postgres', name: '持久化项目' });
    });
    const persisted = await store.read();
    assert.equal(persisted.workspaces[0].id, 'ws_postgres');
    assert.equal(persisted.projects[0].workspaceId, 'ws_postgres');

    await assert.rejects(store.update(data => { data.projects.push({ id: 'must_rollback' }); throw new Error('rollback'); }), /rollback/);
    const afterRollback = await store.read();
    assert.equal(afterRollback.projects.some(item => item.id === 'must_rollback'), false);
    assert.equal((await store.health()).status, 'ready');
  } finally { await store.close(); }
});
