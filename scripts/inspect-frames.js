import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { root } from '../src/config/load.js';

/** Toont lokaal de laatste pakkettypen, desgewenst privé-inhoud; input: commandoregel --hex optioneel; output: console. */
function inspect() {
  const db = new DatabaseSync(join(root, 'data/zonapi.sqlite'), { readOnly: true });
  const frames = db.prepare('SELECT id,received_ms,protocol,record_type,status,raw FROM growatt_frames ORDER BY id DESC LIMIT 20').all();
  for (const row of frames) {
    console.log(`#${row.id} ${new Date(row.received_ms).toISOString()} v${row.protocol} ${row.record_type} ${row.status} (${row.raw.length} bytes)`);
    if (process.argv.includes('--hex')) console.log(Buffer.from(row.raw).toString('hex'));
  }
  if (process.argv.includes('--hex')) console.log('Let op: bovenstaande pakketten kunnen serienummers bevatten. Deel ze alleen na anonimisering.');
  db.close();
}

inspect();
