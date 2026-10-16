import { normalizeGrowattCloud } from '../growatt/cloud/normalize.js';
import { growattTimestamp } from '../growatt/cloud/timestamp.js';

/** Herdateert aantoonbaar verkeerd opgeslagen cloudmetingen met bewaarde webantwoorden; input: SQLite, brontijdzone en standaard omvormertype; output: aantal verplaatste metingen, overige historie blijft staan. */
export function repairGrowattCloudTime(db, timezone, deviceType = 'min') {
  const find = db.prepare('SELECT * FROM cloud_inverter_measurements WHERE serial=? AND measured_ms=?');
  const corrections = new Map();
  const calls = db.prepare(`SELECT * FROM growatt_cloud_calls WHERE status='ok' AND http_status=200
    AND device_serial IS NOT NULL AND response_json IS NOT NULL
    AND request_url LIKE '%/v4/new-api/queryLastData' ORDER BY attempted_ms,id`);
  for (const call of calls.iterate()) {
    let response;
    try { response = JSON.parse(call.response_json); } catch { continue; }
    if (![0, '0'].includes(response?.code ?? response?.error_code)) continue;
    const data = response.data;
    for (const type of Array.isArray(data) ? [deviceType] : ['min', 'inv']) {
      const items = Array.isArray(data) ? data : data?.[type];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const serial = String(item?.serialNum ?? item?.device_sn ?? '').toUpperCase();
        if (serial !== String(call.device_serial).toUpperCase()) continue;
        const previousMs = growattTimestamp(item.calendar, timezone);
        if (previousMs === null) continue;
        const stored = find.get(serial, previousMs);
        if (!stored || stored.received_ms < call.attempted_ms || stored.received_ms > call.attempted_ms + call.duration_ms) continue;
        let corrected;
        try { corrected = normalizeGrowattCloud({ [type]: [item] }, { serial, device_type: type }, stored.received_ms, timezone); }
        catch { continue; }
        if (corrected.measured_ms === previousMs || corrected.power_w !== stored.power_w
          || corrected.energy_today_kwh !== stored.energy_today_kwh || corrected.energy_total_kwh !== stored.energy_total_kwh) continue;
        corrections.set(`${serial}:${previousMs}`, { stored, corrected });
      }
    }
  }
  if (!corrections.size) return 0;
  const remove = db.prepare('DELETE FROM cloud_inverter_measurements WHERE serial=? AND measured_ms=? AND received_ms=?');
  const save = db.prepare(`INSERT INTO cloud_inverter_measurements(serial,measured_ms,received_ms,power_w,energy_today_kwh,energy_total_kwh)
    VALUES(?,?,?,?,?,?) ON CONFLICT(serial,measured_ms) DO UPDATE SET received_ms=excluded.received_ms,power_w=excluded.power_w,
    energy_today_kwh=excluded.energy_today_kwh,energy_total_kwh=excluded.energy_total_kwh
    WHERE excluded.received_ms>cloud_inverter_measurements.received_ms`);
  db.exec('BEGIN IMMEDIATE');
  const moved = [];
  try {
    // Eerst alle bewezen oude sleutels vrijmaken: verschoven reeksen kunnen elkaars oude tijdstippen raken.
    for (const change of corrections.values()) {
      const { stored } = change;
      if (remove.run(stored.serial, stored.measured_ms, stored.received_ms).changes) moved.push(change.corrected);
    }
    for (const row of moved) save.run(row.serial, row.measured_ms, row.received_ms, row.power_w, row.energy_today_kwh, row.energy_total_kwh);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return moved.length;
}
