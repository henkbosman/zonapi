import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const sources = ['growatt', 'weather', 'homewizard'];

/** Maakt de standaardinstellingen voor diagnoseopslag; input: geen; output: afzonderlijke logschakelaars op uit en een bewaarlimiet. */
export function defaultDebugConfiguration() {
  return { logging: { growatt: false, weather: false, homewizard: false, max_entries_per_source: 5000 } };
}

/** Valideert debug.json en vult ontbrekende logvelden aan; input: JSON-object; output: configuratie met booleans en limiet of fout. */
export function normalizeDebugConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('debug.json moet een object bevatten');
  if (value.logging !== undefined && (!value.logging || typeof value.logging !== 'object' || Array.isArray(value.logging))) throw new Error('debug.json: logging moet een object zijn');
  const logging = { ...defaultDebugConfiguration().logging, ...value.logging };
  for (const source of sources) if (typeof logging[source] !== 'boolean') throw new Error(`debug.json: logging.${source} moet true of false zijn`);
  if (!Number.isInteger(logging.max_entries_per_source) || logging.max_entries_per_source < 100 || logging.max_entries_per_source > 100000) throw new Error('debug.json: logging.max_entries_per_source moet 100..100000 zijn');
  return { ...value, logging };
}

/** Beheert het lokale debugbestand als enige bron voor logschakelaars; input: absoluut bestandspad; output: {readLogging,setLogging}, ontbrekend bestand wordt aangemaakt. */
export function createDebugConfiguration(path) {
  try { writeFileSync(path, `${JSON.stringify(defaultDebugConfiguration(), null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }

  /** Leest en valideert het volledige debugbestand; input: geen; output: aangevulde JSON-configuratie of fout. */
  function read() { return normalizeDebugConfiguration(JSON.parse(readFileSync(path, 'utf8'))); }

  /** Leest de actuele bestandsinstellingen en schakelt logs uit bij een leesfout; input: geen; output: logconfiguratie en eventuele foutmelding. */
  function readLogging() {
    try { return { ...read().logging, error: null }; }
    catch (error) { return { ...defaultDebugConfiguration().logging, error: error.message.startsWith('debug.json') ? error.message : `debug.json: ${error.message}` }; }
  }

  /** Bewaart één dashboardwijziging atomair in debug.json; input: bronnaam en boolean; output: void of bestands-/validatiefout. */
  function setLogging(source, enabled) {
    if (!sources.includes(source) || typeof enabled !== 'boolean') throw new Error('Ongeldige loginstelling');
    const config = read();
    config.logging[source] = enabled;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }

  read();
  return { readLogging, setLogging };
}
