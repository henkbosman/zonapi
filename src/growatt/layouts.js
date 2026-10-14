import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Offset is een bytepositie in het ontsleutelde volledige frame. Grott gebruikt hex-tekenposities: hier /2.
const builtIn = {
  T02NNNN: { serial: 18, date: 28, power: 61, today: 91, total: 95 },
  T05NNNN: { serial: 18, date: 28, power: 61, today: 91, total: 95 },
  T05NNNNX: { serial: 18, date: 28, power: 85, today: 137, total: 141 },
  T06NNNN: { serial: 38, date: 68, power: 101, today: 131, total: 135 },
  T06NNNNX: { serial: 38, date: 68, power: 125, today: 177, total: 181 }
};

/** Zoekt een exacte layout-override of de Grott-standaard; input: protocol, subcode, berichtsoort, framelengte, map; output: {id,offsets} of null. */
export function selectLayout(version, subtype, kind, length, directory) {
  if (![0x04, 0x50].includes(kind)) return null;
  const short = `T${version.toString(16).padStart(2, '0')}`.toUpperCase();
  const exact = `${short}${subtype.toString(16).padStart(2, '0')}${kind.toString(16).padStart(2, '0')}${length > 375 ? 'X' : ''}`.toUpperCase();
  const file = join(directory, `${exact}.json`);
  if (existsSync(file)) return { id: exact, offsets: JSON.parse(readFileSync(file, 'utf8')) };
  const generic = `${short}NNNN${length > 375 ? 'X' : ''}`;
  return builtIn[generic] ? { id: generic, offsets: builtIn[generic] } : null;
}
