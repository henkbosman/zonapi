/** Maakt beperkte databasebewerkingen; input: open SQLite DB; output: repositorymethoden. */
export function createRepository(db) {
  const q = {
    forecast: db.prepare('INSERT INTO forecast VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(start_ms,end_ms) DO UPDATE SET source=excluded.source,ghi=excluded.ghi,dni=excluded.dni,dhi=excluded.dhi,fetched_ms=excluded.fetched_ms WHERE excluded.fetched_ms > forecast.fetched_ms'),
    pv: db.prepare('INSERT INTO pv_forecast VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(group_id,start_ms,end_ms) DO UPDATE SET source=excluded.source,power_w=excluded.power_w,gti_w_m2=excluded.gti_w_m2,fetched_ms=excluded.fetched_ms WHERE excluded.fetched_ms > pv_forecast.fetched_ms'),
    sun: db.prepare('INSERT INTO sun_times VALUES (?, ?, ?, ?, ?) ON CONFLICT(local_date) DO UPDATE SET sunrise_ms=excluded.sunrise_ms,sunset_ms=excluded.sunset_ms,source=excluded.source,fetched_ms=excluded.fetched_ms WHERE excluded.fetched_ms > sun_times.fetched_ms'),
    call: db.prepare('INSERT INTO weather_calls(local_date,attempted_ms,status) VALUES(?,?,?)'),
    callUpdate: db.prepare('UPDATE weather_calls SET status=?,detail=? WHERE id=?'),
    frame: db.prepare('INSERT INTO growatt_frames(received_ms,peer,protocol,record_type,status,raw) VALUES(?,?,?,?,?,?)'),
    frameUpdate: db.prepare('UPDATE growatt_frames SET status=? WHERE id=?'),
    growattEvent: db.prepare('INSERT INTO growatt_events(at_ms,peer,kind,detail) VALUES(?,?,?,?)'),
    inverter: db.prepare('INSERT INTO inverter_measurements VALUES (?,?,?,?,?,?,?) ON CONFLICT(serial,measured_ms) DO UPDATE SET received_ms=excluded.received_ms,power_w=excluded.power_w,energy_today_kwh=excluded.energy_today_kwh,energy_total_kwh=excluded.energy_total_kwh,frame_id=excluded.frame_id WHERE excluded.received_ms > inverter_measurements.received_ms'),
    meter: db.prepare('INSERT INTO meter_measurements VALUES (?,?,?,?,?,?) ON CONFLICT(device,measured_ms) DO UPDATE SET received_ms=excluded.received_ms,net_power_w=excluded.net_power_w,import_kwh=excluded.import_kwh,export_kwh=excluded.export_kwh WHERE excluded.received_ms > meter_measurements.received_ms')
  };

  return {
    /** Slaat één nieuwer weertijdvak op; input: {source,start_ms,end_ms,ghi,dni,dhi,fetched_ms}; output: SQLite-resultaat. */
    saveForecast(row) { return q.forecast.run(row.source, row.start_ms, row.end_ms, row.ghi, row.dni, row.dhi, row.fetched_ms); },
    /** Slaat berekende paneelgroepuitkomst op; input: PV-rij; output: SQLite-resultaat. */
    savePv(row) { return q.pv.run(row.group_id, row.start_ms, row.end_ms, row.source, row.power_w, row.gti_w_m2, row.fetched_ms); },
    /** Slaat daglichtgrenzen op; input: dag, zontijden, bron, ophaaltijd; output: SQLite-resultaat. */
    saveSun(day, sunrise, sunset, source, fetched) { return q.sun.run(day, sunrise, sunset, source, fetched); },
    /** Geeft zontijden terug; input: lokale datum; output: rij of undefined. */
    getSun(day) { return db.prepare('SELECT * FROM sun_times WHERE local_date=?').get(day); },
    /** Reserveert een quotapoging voor het HTTP-verzoek; input: dag en tijd; output: poging-id. */
    beginCall(day, now) { return Number(q.call.run(day, now, 'pending').lastInsertRowid); },
    /** Rondt een poging af; input: id, status, detail; output: SQLite-resultaat. */
    finishCall(id, status, detail = null) { return q.callUpdate.run(status, detail?.slice(0, 200) ?? null, id); },
    /** Telt alle pogingen van de lokale dag; input: lokale datum; output: aantal. */
    countCalls(day) { return db.prepare('SELECT COUNT(*) AS n FROM weather_calls WHERE local_date=?').get(day).n; },
    /** Leest meest recente poging; input: geen; output: rij of undefined. */
    lastCall() { return db.prepare('SELECT * FROM weather_calls ORDER BY attempted_ms DESC,id DESC LIMIT 1').get(); },
    /** Bewaart ontvangen TCP-pakket voor diagnose; input: tijd, peer, versie, type, status, Buffer; output: rij-id. */
    saveFrame(at, peer, version, type, status, raw) { return Number(q.frame.run(at, peer, version, type, status, raw).lastInsertRowid); },
    /** Corrigeert de parse-status van een pakket; input: rij-id, status; output: SQLite-resultaat. */
    markFrame(id, status) { return q.frameUpdate.run(status, id); },
    /** Bewaart een fout van de TCP-ontvanger; input: tijd, peer, soort, detail; output: SQLite-resultaat. */
    saveGrowattEvent(at, peer, kind, detail) { return q.growattEvent.run(at, peer, kind, String(detail).slice(0, 300)); },
    /** Verwijdert alleen ruwe Growatt-berichten en logs; input: geen; output: aantallen verwijderde rijen (metingen blijven staan). */
    clearGrowattDiagnostics() {
      db.exec('BEGIN');
      try {
        const frames_deleted = db.prepare('DELETE FROM growatt_frames').run().changes;
        const events_deleted = db.prepare('DELETE FROM growatt_events').run().changes;
        db.exec('COMMIT');
        return { frames_deleted, events_deleted };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    /** Leest recente pakketmetadata zonder ruwe inhoud; input: limiet; output: nieuwste rijen. */
    recentGrowattFrames(limit) { return db.prepare('SELECT id,received_ms,peer,protocol,record_type,status,length(raw) AS size_bytes FROM growatt_frames ORDER BY id DESC LIMIT ?').all(limit); },
    /** Leest pakketten en TCP-gebeurtenissen als één tijdlijn met filters; input: {limit,offset,type,address,view}; output: {rows,has_more}. */
    growattTimeline({ limit, offset, type, address, view }) {
      const frames = [];
      const frameParams = [];
      const events = [];
      const eventParams = [];
      if (type) {
        frames.push(type.startsWith('xx') ? 'substr(record_type,3,2)=?' : 'record_type=?');
        frameParams.push(type.startsWith('xx') ? type.slice(2) : type);
      }
      if (address) { frames.push('substr(record_type,1,2)=?'); frameParams.push(address); }
      if (view === 'errors') {
        frames.push("status NOT IN ('control','announcement') AND status NOT LIKE 'decoded:%'");
        events.push("kind NOT IN ('connected','disconnected','idle_disconnect','reply_sent','time_sync_sent','time_sync_response')");
      }
      const frameSql = `SELECT id,received_ms AS at_ms,peer,'packet' AS source,protocol,record_type,status,length(raw) AS size_bytes,NULL AS detail FROM growatt_frames ${frames.length ? `WHERE ${frames.join(' AND ')}` : ''}`;
      const eventSql = `SELECT id,at_ms,peer,'event' AS source,NULL AS protocol,NULL AS record_type,kind AS status,NULL AS size_bytes,detail FROM growatt_events ${events.length ? `WHERE ${events.join(' AND ')}` : ''}`;
      const withFrames = view !== 'events';
      const withEvents = !type && !address && view !== 'packets';
      if (!withFrames && !withEvents) return { rows: [], has_more: false };
      const parts = [];
      const params = [];
      if (withFrames) { parts.push(frameSql); params.push(...frameParams); }
      if (withEvents) { parts.push(eventSql); params.push(...eventParams); }
      const rows = db.prepare(`${parts.join(' UNION ALL ')} ORDER BY at_ms DESC,source DESC,id DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
      return { rows: rows.slice(0, limit), has_more: rows.length > limit };
    },
    /** Leest de laatste aanmelding per ShineLanBox-adres, inclusief bestaande historie; input: geen; output: maximaal vier frame-rijen. */
    latestGrowattAnnouncements() { return db.prepare(`
      SELECT id,received_ms,record_type,raw FROM growatt_frames
      WHERE id IN (
        SELECT MAX(id) FROM growatt_frames
        WHERE protocol=6 AND record_type IN ('5003','5029','5103','5129','5203','5229','5303','5329')
          AND status IN ('control','announcement')
        GROUP BY substr(record_type,1,2)
      ) ORDER BY id DESC
    `).all(); },
    /** Leest één compleet pakket; input: positief rij-id; output: rij met Buffer of undefined. */
    growattFrame(id) { return db.prepare('SELECT * FROM growatt_frames WHERE id=?').get(id); },
    /** Leest de gedecodeerde meting bij één pakket; input: rij-id; output: meting of undefined. */
    growattFrameMeasurement(id) { return db.prepare('SELECT serial,measured_ms,power_w,energy_today_kwh,energy_total_kwh FROM inverter_measurements WHERE frame_id=? LIMIT 1').get(id); },
    /** Leest fouten in pakketten en TCP-ontvanger; input: limiet; output: nieuwste foutregels. */
    recentGrowattProblems(limit) { return db.prepare(`
      SELECT received_ms AS at_ms,peer,status,record_type AS detail,id AS frame_id
      FROM growatt_frames WHERE status NOT IN ('control','announcement') AND status NOT LIKE 'decoded:%'
      UNION ALL
      SELECT at_ms,peer,kind AS status,detail,NULL AS frame_id FROM growatt_events WHERE kind NOT IN ('connected','disconnected','idle_disconnect','reply_sent','time_sync_sent','time_sync_response')
      ORDER BY at_ms DESC LIMIT ?
    `).all(limit); },
    /** Bewaart omvormermeting zonder oude buffers live te maken; input: meetobject; output: SQLite-resultaat. */
    saveInverter(v) { return q.inverter.run(v.serial, v.measured_ms, v.received_ms, v.power_w, v.energy_today_kwh, v.energy_total_kwh, v.frame_id); },
    /** Bewaart lokale HomeWizard-meting; input: meetobject; output: SQLite-resultaat. */
    saveMeter(v) { return q.meter.run(v.device, v.measured_ms, v.received_ms, v.net_power_w, v.import_kwh, v.export_kwh); },
    /** Leest voorspellingen uit een tijdvenster; input: begin en einde in ms; output: geordende rijen. */
    forecast(from, to) { return db.prepare('SELECT * FROM forecast WHERE end_ms>? AND start_ms<? ORDER BY start_ms').all(from, to); },
    /** Leest opgeslagen berekende PV-opbrengst; input: begin en einde in ms; output: rijen. */
    pv(from, to) { return db.prepare('SELECT * FROM pv_forecast WHERE end_ms>? AND start_ms<? ORDER BY start_ms,group_id').all(from, to); },
    /** Leest laatste meting per omvormer; input: geen; output: rijen per serienummer. */
    currentInverters() { return db.prepare('SELECT m.* FROM inverter_measurements m WHERE NOT EXISTS (SELECT 1 FROM inverter_measurements x WHERE x.serial=m.serial AND (x.measured_ms>m.measured_ms OR (x.measured_ms=m.measured_ms AND x.received_ms>m.received_ms)))').all(); },
    /** Leest laatste meting van elk HomeWizard-apparaat; input: geen; output: rijen per apparaat. */
    currentMeters() { return db.prepare('SELECT m.* FROM meter_measurements m WHERE m.measured_ms=(SELECT MAX(x.measured_ms) FROM meter_measurements x WHERE x.device=m.device)').all(); },
    /** Leest recente netto metingen voor basislastschatting; input: apparaat-id en begin-ms; output: meetreeks. */
    meterHistory(device, from) { return db.prepare('SELECT measured_ms,net_power_w FROM meter_measurements WHERE device=? AND measured_ms>=? ORDER BY measured_ms DESC LIMIT 25000').all(device, from); },
    /** Leest recente omvormermetingen voor basislastschatting; input: begin-ms; output: meetreeks. */
    inverterHistory(from) { return db.prepare('SELECT serial,measured_ms,power_w FROM inverter_measurements WHERE measured_ms>=? ORDER BY measured_ms DESC LIMIT 40000').all(from); },
    /** Leest historisch meetpunt met veilige metriekkeuze; input: soort, begin, einde, limiet; output: rijen. */
    history(metric, from, to, limit) {
      const tables = { inverter: ['inverter_measurements', 'measured_ms'], p1: ['meter_measurements', 'measured_ms'], kwh: ['meter_measurements', 'measured_ms'], irradiance: ['forecast', 'start_ms'], pv_forecast: ['pv_forecast', 'start_ms'] };
      const entry = tables[metric];
      if (!entry) throw new Error('Onbekende historie-metric');
      const deviceClause = metric === 'p1' || metric === 'kwh' ? ' AND device=?' : '';
      const sql = `SELECT * FROM ${entry[0]} WHERE ${entry[1]}>=? AND ${entry[1]}<?${deviceClause} ORDER BY ${entry[1]} LIMIT ?`;
      return db.prepare(sql).all(...(deviceClause ? [from, to, metric, limit] : [from, to, limit]));
    },
    /** Leest diagnostische frame-tellingen; input: geen; output: rijen per status. */
    frameStatus() { return db.prepare('SELECT status,COUNT(*) AS count FROM growatt_frames GROUP BY status').all(); },
    /** Geeft het pad van de actieve hoofddatabase; input: geen; output: absoluut pad of null bij geheugenopslag. */
    databasePath() { return db.prepare('PRAGMA database_list').all().find((item) => item.name === 'main')?.file || null; },
    /** Leest database-instantie voor gecontroleerde transacties; input: geen; output: DatabaseSync. */
    database() { return db; }
  };
}
