import { backup } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { localDay } from '../weather/local-day.js';

/** Start dagelijkse veilige SQLite-backups zonder actieve WAL te kopiëren; input: db en datamap; output: {run,start,stop}. */
export function createBackupJob(db, directory) {
  let timer = null;
  let running = false;

  /** Maakt één back-up per lokale kalenderdag; input: geen; output: Promise met bestandspad of null. */
  async function run() {
    if (running) return null;
    const folder = join(directory, 'backups');
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `zonapi-${localDay(Date.now())}.sqlite`);
    running = true;
    const temporary = `${path}.tmp`;
    try {
      if (existsSync(temporary)) rmSync(temporary);
      await backup(db, temporary);
      renameSync(temporary, path);
      return path;
    }
    catch (error) { console.error('SQLite-back-up:', error.message); if (existsSync(temporary)) rmSync(temporary); return null; }
    finally { running = false; }
  }

  /** Plant controles op een bestaande dagelijkse back-up; input: geen; output: void. */
  function start() { void run(); timer = setInterval(() => { void run(); }, 6 * 3600000); }

  /** Stopt dagelijkse controles; input: geen; output: void. */
  function stop() { if (timer) clearInterval(timer); }

  return { run, start, stop };
}
