/** Bewaart weerquota en actuele status los van uitschakelbare logs; input: SQLite en diagnoseopslag; output: weerpogingmethoden. */
export function createWeatherCallStore(db, diagnostics) {
  /** Reserveert een weeraanvraag binnen een transactie; input: lokale datum, tijd-ms en bron; output: pogingobject. */
  function beginCall(day, now, source = null) {
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO weather_usage VALUES(?,1) ON CONFLICT(local_date) DO UPDATE SET attempts=attempts+1').run(day);
      const id = diagnostics.loggingStatus('weather').enabled
        ? Number(db.prepare("INSERT INTO weather_calls(local_date,attempted_ms,status,source) VALUES(?,?,'pending',?)").run(day, now, source).lastInsertRowid) : null;
      const attempt = { id, local_date: day, attempted_ms: now, source, status: 'pending', detail: null };
      diagnostics.saveDiagnosticState('weather', 'last_call', attempt);
      db.exec('COMMIT');
      return attempt;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  /** Bewaart het resultaat en actualiseert een eventueel gelogde poging; input: poging, status, metadata; output: void. */
  function finishCall(attempt, status, { detail = null, request_url = null, http_status = null, duration_ms = null, forecast_rows = null, sun_days = null } = {}) {
    const row = { ...attempt, status, detail: detail === null ? null : String(detail).slice(0, 600), request_url, http_status, duration_ms, forecast_rows, sun_days };
    db.exec('BEGIN');
    try {
      if (attempt.id !== null) db.prepare('UPDATE weather_calls SET status=?,detail=?,request_url=?,http_status=?,duration_ms=?,forecast_rows=?,sun_days=? WHERE id=? AND attempted_ms=? AND local_date=?')
        .run(status, row.detail, request_url, http_status, duration_ms, forecast_rows, sun_days, attempt.id, attempt.attempted_ms, attempt.local_date);
      diagnostics.saveDiagnosticState('weather', 'last_call', row);
      if (status === 'ok') diagnostics.saveDiagnosticState('weather', 'last_success', row);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    diagnostics.trimDiagnostics('weather');
  }

  return {
    beginCall, finishCall,
    /** Telt alle pogingen onafhankelijk van logging; input: lokale datum; output: aantal. */
    countCalls(day) { return db.prepare('SELECT attempts FROM weather_usage WHERE local_date=?').get(day)?.attempts ?? 0; },
    /** Leest de laatste poging, ook als logging uit staat; input: geen; output: object of null. */
    lastCall() { return diagnostics.diagnosticState('weather', 'last_call'); },
    /** Leest de laatste succesvolle poging; input: geen; output: object of null. */
    lastSuccessfulWeatherCall() { return diagnostics.diagnosticState('weather', 'last_success'); },
    /** Wist het weerlog met behoud van quota en voorspellingen; input: geen; output: verwijderd aantal. */
    clearWeatherDiagnostics() { return { calls_deleted: db.prepare('DELETE FROM weather_calls').run().changes }; }
  };
}
