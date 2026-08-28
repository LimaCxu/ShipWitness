import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const collections = ['workspaces', 'users', 'memberships', 'sessions', 'apiKeys', 'projects', 'contracts', 'runs', 'issues', 'decisions', 'auditEvents', 'signedDossiers', 'webhooks', 'webhookDeliveries', 'alerts', 'auditExports', 'invitations'];
const emptyStore = () => Object.fromEntries(collections.map(name => [name, []]));

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      for (const key of collections) data[key] ||= [];
      return data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return emptyStore();
    }
  }

  async update(mutator) {
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const data = await this.read();
      const result = await mutator(data);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await rename(temp, this.file);
      return result;
    });
    return this.queue;
  }

  async health() { return { status: 'ready', engine: 'json-file', file: this.file }; }
}

export const createId = prefix => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
