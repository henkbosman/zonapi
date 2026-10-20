import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { loadConfiguration } from '../src/config/load.js';
import { correctionModelKey } from '../src/pv/correction-key.js';
import { createPvForecastModel } from '../src/pv/forecast-model.js';
import { refreshPvForecast } from '../src/pv/refresh-forecast.js';

test('v5-migratie behoudt echte eigen correcties en brondata; overgenomen cachefactoren worden losgemaakt', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-block-migration-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'data.sqlite'), { settings } = loadConfiguration(); settings.location = { latitude: 52, longitude: 5 };
  const panels = { inverters: [{ id: 'mic', serial: 'TEST123456', ac_limit_w: 2000 }],
    groups: [{ id: 'zuid', inverter_id: 'mic', count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 }] };
  const end = Date.parse('2026-10-18T12:15:00Z'), now = end + 600000, key = correctionModelKey(settings, panels);
  let db = openDatabase(path), repository = createRepository(db);
  for (let index = -1; index < 4; index++) {
    const start = end + index * 900000;
    const row = { source: 'open-meteo', start_ms: start, end_ms: start + 900000, ghi: 500, dni: 0, dhi: 500, fetched_ms: end - 900000 };
    repository.saveForecast(row);
    repository.savePv({ ...row, group_id: 'zuid', power_w: 600, base_power_w: 1000, correction_factor: 0.6, model_key: key, gti_w_m2: 500, computed_ms: now });
  }
  const previousDay = end - 86400000;
  repository.saveForecast({ source: 'open-meteo', start_ms: previousDay - 900000, end_ms: previousDay, ghi: 500, dni: 0, dhi: 500, fetched_ms: end - 900000 });
  repository.savePvCorrection({ model_key: key, quarter_minute: 14 * 60 + 15, factor: 0.6, predicted_w: 1000, measured_w: 600,
    measured_ms: end + 300000, updated_ms: now, signature: 'original', sampling_json: JSON.stringify({ target_time: new Date(end).toISOString(), samples: [] }) });
  repository.savePvCorrection({ model_key: key, quarter_minute: 14 * 60 + 30, factor: 0.4, predicted_w: 1000, measured_w: 400,
    measured_ms: end + 300000, updated_ms: now, signature: 'no-exact-date' });
  const raw = repository.forecastCandidates(0, Infinity).map((row) => ({ ...row }));
  db.exec('DROP TABLE pv_block_corrections; PRAGMA user_version=5'); db.close();
  db = openDatabase(path); repository = createRepository(db);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.deepEqual(repository.forecastCandidates(0, Infinity).map((row) => ({ ...row })), raw);
    assert.equal(repository.pvCorrectionPattern(key).length, 2);
    assert.equal(repository.pvBlockCorrections(key).length, 1);
    const cached = repository.pv(end - 900000, end + 3 * 900000);
    assert.equal(cached.find((row) => row.end_ms === end).correction_factor, 0.6);
    assert.ok(cached.filter((row) => row.end_ms !== end).every((row) => row.correction_factor === 1 && row.power_w === row.base_power_w));
    const model = createPvForecastModel(repository, settings, panels, now);
    const own = model.prepare(repository.forecast(end - 1, end))[0];
    assert.equal(model.estimate(own).power_w, 600);
    refreshPvForecast(repository, settings, panels, [], now);
    assert.equal(repository.pvBlockCorrections(key).length, 1);
    const block = { ...repository.pvBlockCorrections(key)[0] };
    db.close(); db = openDatabase(path); repository = createRepository(db);
    assert.deepEqual({ ...repository.pvBlockCorrections(key)[0] }, block);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});

test('oude rijen zonder betrouwbare datering blijven bewaard en worden niet op een willekeurig blok toegepast', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-block-legacy-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'data.sqlite'); let db = openDatabase(path), repository = createRepository(db);
  const key = 'a'.repeat(64), now = Date.parse('2026-10-18T12:30:00Z');
  for (const [index, sampling_json] of [null, '{', '{}', 'null', JSON.stringify({ target_time: 'ongeldig' }), JSON.stringify({ target_time: new Date(now + 900000).toISOString() })].entries()) {
    repository.savePvCorrection({ model_key: key, quarter_minute: index * 15, factor: 0.5, predicted_w: 1000, measured_w: 500, measured_ms: now, updated_ms: now, signature: String(index), sampling_json });
  }
  db.exec('DROP TABLE pv_block_corrections; PRAGMA user_version=5'); db.close(); db = openDatabase(path); repository = createRepository(db);
  try { assert.equal(repository.pvCorrectionPattern(key).length, 6); assert.equal(repository.pvBlockCorrections(key).length, 0); }
  finally { db.close(); }
});
