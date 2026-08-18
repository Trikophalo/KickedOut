import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.KO_DATA_DIR || join(ROOT, 'data');

/**
 * Winzige JSON-Persistenz mit gebündelten Schreibvorgängen.
 * Reicht für Fragen-Telemetrie und das Gruppen-Gedächtnis; ein echter
 * Betrieb würde hier Postgres einhängen (siehe KONZEPT.md §6.4).
 */
export class Store {
  constructor(name, fallback) {
    this.file = join(DATA_DIR, `${name}.json`);
    this.data = fallback;
    this.dirty = false;
    this.timer = null;
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      this.data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] ${this.file} unlesbar:`, err.message);
    }
    return this.data;
  }

  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => console.warn('[store] Schreibfehler:', err.message));
    }, 2000);
    this.timer.unref?.();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 1));
    await rename(tmp, this.file);
  }
}
