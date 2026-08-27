import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const emptyStore = () => ({ projects: [], contracts: [], runs: [], issues: [], decisions: [] });

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return emptyStore();
    }
  }

  async update(mutator) {
    this.queue = this.queue.then(async () => {
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
}

export const createId = prefix => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
