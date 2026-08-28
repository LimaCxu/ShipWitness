import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const collections = ['workspaces', 'users', 'memberships', 'sessions', 'apiKeys', 'projects', 'contracts', 'runs', 'issues', 'decisions', 'auditEvents', 'signedDossiers', 'webhooks', 'webhookDeliveries', 'alerts', 'auditExports'];

const emptyStore = () => Object.fromEntries(collections.map(name => [name, []]));

export class PostgresStore {
  constructor(connectionString, { migrationsDir = new URL('../migrations/', import.meta.url) } = {}) {
    this.pool = new Pool({ connectionString, max: Number(process.env.SHIPWITNESS_DB_POOL_SIZE || 10), connectionTimeoutMillis: 5000 });
    this.migrationsDir = migrationsDir;
    this.initializing = null;
  }

  async ready() {
    if (!this.initializing) this.initializing = this.#migrate().catch(error => { this.initializing = null; throw error; });
    return this.initializing;
  }

  async #migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(73194720)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(row => Number(row.version)));
      const files = (await readdir(this.migrationsDir)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
      for (const file of files) {
        const version = Number(file.match(/^\d+/)[0]);
        if (applied.has(version)) continue;
        const sql = await readFile(new URL(file, this.migrationsDir), 'utf8');
        await client.query('BEGIN');
        try { await client.query(sql); await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]); await client.query('COMMIT'); }
        catch (error) { await client.query('ROLLBACK'); throw error; }
      }
    } finally { try { await client.query('SELECT pg_advisory_unlock(73194720)'); } finally { client.release(); } }
  }

  async #readWith(client) {
    const data = emptyStore();
    const result = await client.query(`SELECT source, payload FROM (${collections.map(name => `SELECT '${name}' AS source, payload FROM ${name}`).join(' UNION ALL ')}) records`);
    for (const row of result.rows) data[row.source].push(row.payload);
    return data;
  }

  async read() {
    await this.ready();
    return this.#readWith(this.pool);
  }

  async update(mutator) {
    await this.ready();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query('SELECT pg_advisory_xact_lock(73194721)');
        const data = await this.#readWith(client);
        const result = await mutator(data);
        for (const name of collections) {
          const ids = data[name].map(item => item.id);
          if (ids.length) await client.query(`DELETE FROM ${name} WHERE NOT (id = ANY($1::text[]))`, [ids]);
          else await client.query(`DELETE FROM ${name}`);
          for (const item of data[name]) await client.query(`INSERT INTO ${name} (id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`, [item.id, JSON.stringify(item)]);
        }
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.code !== '40001' || attempt === 2) throw error;
      } finally { client.release(); }
    }
  }

  async health() {
    await this.ready();
    const result = await this.pool.query('SELECT current_database() AS database, version() AS version');
    return { status: 'ready', database: result.rows[0].database, engine: result.rows[0].version.split(' ').slice(0, 2).join(' ') };
  }

  async close() { await this.pool.end(); }
}
