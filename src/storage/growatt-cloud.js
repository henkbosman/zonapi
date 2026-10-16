/** Bewaart Growatt-cloudmetingen en gedeelde Growatt-diagnose; input: SQLite en diagnoseopslag; output: meet- en logmethoden zonder tokens. */
export function createGrowattCloudStore(db, diagnostics) {
  const save = db.prepare(`INSERT INTO cloud_inverter_measurements(serial,measured_ms,received_ms,power_w,energy_today_kwh,energy_total_kwh)
    VALUES(?,?,?,?,?,?) ON CONFLICT(serial,measured_ms) DO UPDATE SET received_ms=excluded.received_ms,power_w=excluded.power_w,
    energy_today_kwh=excluded.energy_today_kwh,energy_total_kwh=excluded.energy_total_kwh WHERE excluded.received_ms>cloud_inverter_measurements.received_ms`);
  const log = db.prepare('INSERT INTO growatt_cloud_calls(attempted_ms,method,request_url,device_serial,status,http_status,duration_ms,detail,response_json) VALUES(?,?,?,?,?,?,?,?,?)');
  return {
    /** Bewaart één cloudmeting per echte meettijd; input: genormaliseerde omvormermeting; output: SQLite-resultaat, geen extra punt voor een herhaalde oude meting. */
    saveCloudInverter(row) { return save.run(row.serial, row.measured_ms, row.received_ms, row.power_w, row.energy_today_kwh, row.energy_total_kwh); },
    /** Leest de laatste cloudmeting per serienummer; input: geen; output: rijen met bron cloud. */
    currentCloudInverters() { return db.prepare(`SELECT m.*,'cloud' AS source FROM cloud_inverter_measurements m WHERE NOT EXISTS
      (SELECT 1 FROM cloud_inverter_measurements x WHERE x.serial=m.serial AND x.measured_ms>m.measured_ms)`).all(); },
    /** Leest een begrensde cloudmeetreeks; input: begin, einde, limiet; output: chronologische rijen met bron cloud. */
    cloudInverterHistory(from, to, limit = 40000) { return db.prepare("SELECT *,'cloud' AS source FROM cloud_inverter_measurements WHERE measured_ms>=? AND measured_ms<? ORDER BY measured_ms LIMIT ?").all(from, to, limit); },
    /** Bewaart geschoonde HTTP-diagnose onder de Growatt-logschakelaar; input: verzoekmetadata met geschoond antwoord; output: log-id of null. */
    saveGrowattCloudCall(row) {
      diagnostics.saveDiagnosticState('growatt', 'cloud_last_request', { attempted_ms: row.attempted_ms, status: row.status, http_status: row.http_status, duration_ms: row.duration_ms, request_url: row.request_url, detail: row.detail });
      if (!diagnostics.loggingStatus('growatt').enabled) return null;
      const result = log.run(row.attempted_ms, row.method, row.request_url, row.device_serial, row.status, row.http_status, row.duration_ms, row.detail, row.response_json);
      diagnostics.trimDiagnostics('growatt');
      return Number(result.lastInsertRowid);
    },
    /** Leest één opgeslagen webverzoek; input: positief log-id; output: metadata en geschoond antwoord of undefined. */
    growattCloudCall(id) { return db.prepare('SELECT * FROM growatt_cloud_calls WHERE id=?').get(id); }
  };
}
