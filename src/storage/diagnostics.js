const sources = ['growatt', 'weather', 'homewizard'];

/** Beheert begrensde diagnoseopslag; input: SQLite en optionele debugbestandbeheerder of losse logconfiguratie; output: opslagmethoden. */
export function createDiagnosticStore(db, config = {}) {
  const writes = new Map();
  const read = db.prepare('SELECT enabled FROM diagnostic_settings WHERE source=?');
  const state = db.prepare('INSERT INTO diagnostic_state(source,name,value) VALUES(?,?,?) ON CONFLICT(source,name) DO UPDATE SET value=excluded.value');

  /** Controleert een logbron; input: bronnaam; output: void of fout. */
  function check(source) { if (!sources.includes(source)) throw new Error('Onbekende logbron'); }

  /** Leest de actuele logschakelaar uit debug.json of een zelfstandige opslag; input: bronnaam; output: enabled, bewaarlimiet en eventuele configuratiefout. */
  function loggingStatus(source) {
    check(source);
    if (typeof config.readLogging === 'function') {
      const current = config.readLogging();
      return { enabled: current[source], max_entries: current.max_entries_per_source, error: current.error };
    }
    return { enabled: read.get(source)?.enabled !== 0, max_entries: config.max_entries_per_source ?? 5000 };
  }

  /** Bewaart een logschakelaar in debug.json of zelfstandige opslag; input: bron en boolean; output: actuele loginstelling. */
  function setLogging(source, enabled) {
    check(source);
    if (typeof enabled !== 'boolean') throw new Error('enabled moet true of false zijn');
    if (typeof config.setLogging === 'function') config.setLogging(source, enabled);
    else db.prepare('INSERT INTO diagnostic_settings VALUES(?,?) ON CONFLICT(source) DO UPDATE SET enabled=excluded.enabled').run(source, Number(enabled));
    return loggingStatus(source);
  }

  /** Bewaart uitsluitend de laatste toestand per sleutel; input: bron, sleutel en JSON-object; output: void. */
  function saveDiagnosticState(source, name, value) { check(source); state.run(source, name, JSON.stringify(value)); }

  /** Leest de laatste toestand zonder het logboek te raadplegen; input: bron en sleutel; output: object of null. */
  function diagnosticState(source, name) {
    check(source);
    const row = db.prepare('SELECT value FROM diagnostic_state WHERE source=? AND name=?').get(source, name);
    return row ? JSON.parse(row.value) : null;
  }

  /** Begrensd bewaren van ruwe diagnosegegevens; input: bron en force om direct te schonen; output: void. */
  function trimDiagnostics(source, force = false) {
    check(source);
    if (!force) {
      const count = (writes.get(source) ?? 0) + 1;
      writes.set(source, count);
      if (count % 100 !== 0) return;
    }
    const maxEntries = loggingStatus(source).max_entries;
    if (source === 'growatt') {
      const kept = db.prepare(`SELECT kind,MIN(id) AS first_id FROM (
        SELECT * FROM (SELECT id,received_ms AS at_ms,'frame' AS kind FROM growatt_frames
          UNION ALL SELECT id,at_ms,'event' AS kind FROM growatt_events
          UNION ALL SELECT id,attempted_ms AS at_ms,'cloud' AS kind FROM growatt_cloud_calls)
        ORDER BY at_ms DESC,id DESC,kind DESC LIMIT ?
      ) GROUP BY kind`).all(maxEntries);
      for (const [kind, table] of [['frame', 'growatt_frames'], ['event', 'growatt_events'], ['cloud', 'growatt_cloud_calls']]) {
        const first = kept.find((row) => row.kind === kind)?.first_id;
        if (first === undefined) db.exec(`DELETE FROM ${table}`);
        else db.prepare(`DELETE FROM ${table} WHERE id<?`).run(first);
      }
    } else {
      const table = source === 'weather' ? 'weather_calls' : 'homewizard_calls';
      db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ?)`).run(maxEntries);
    }
  }

  for (const source of sources) trimDiagnostics(source, true);
  return { loggingStatus, setLogging, saveDiagnosticState, diagnosticState, trimDiagnostics };
}
