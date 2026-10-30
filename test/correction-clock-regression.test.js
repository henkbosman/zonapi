import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { correctionModelKey } from '../src/pv/correction-key.js';
import { createPvForecastModel } from '../src/pv/forecast-model.js';
import { localDayRange } from '../src/weather/local-calendar.js';

const cases = [
  { source: '2026-10-29T08:45:00Z', next: '2026-10-30T08:45:00Z', day: '2026-10-30', hours: 24 },
  { source: '2026-07-01T07:45:00Z', next: '2026-07-02T07:45:00Z', day: '2026-07-02', hours: 24 },
  { source: '2026-10-24T07:45:00Z', next: '2026-10-25T08:45:00Z', day: '2026-10-25', hours: 25 },
  { source: '2026-03-28T08:45:00Z', next: '2026-03-29T07:45:00Z', day: '2026-03-29', hours: 23 }
];

/** Bewaart een echte correctie voor 09:30–09:45 en schat volgende tijdvakken; input: bron, klok en optioneel SQLite-pad; output: database en modelcontext. */
function fixture({ source, now, path = ':memory:' }) {
  const { settings } = loadConfiguration();
  settings.location = { latitude: 52, longitude: 5 };
  const panels = { inverters: [{ id: 'inv', serial: 'CLOCKTEST1', ac_limit_w: 4000 }],
    groups: [{ id: 'vlak', inverter_id: 'inv', count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 }] };
  const db = openDatabase(path), repository = createRepository(db), key = correctionModelKey(settings, panels);
  const end = Date.parse(source), updated = now - 60000;
  repository.savePvBlockCorrection({ model_key: key, start_ms: end - 900000, end_ms: end, factor: 1.079,
    predicted_w: 1000, measured_w: 1079, measured_ms: end + 300000, updated_ms: updated,
    signature: `clock-${source}`, sampling_json: null });
  return { db, repository, settings, panels, key, updated };
}

/** Schat één onafhankelijk kwartier met een basis van 1000 W; input: modelcontext, blokeinde en peiltijd; output: publiek bruikbare vermogens- en referentiewaarden. */
function value(f, end, now) {
  return createPvForecastModel(f.repository, f.settings, f.panels, now).estimate({ source: 'open-meteo', model: 'best_match',
    start_ms: end - 900000, end_ms: end, ghi: 500, dni: 0, dhi: 500, fetched_ms: now });
}

test('+7,9% voor 09:45 blijft de volgende dag op 09:45, ook na een etmaal van 23 of 25 uur', () => {
  for (const scenario of cases) {
    const now = localDayRange(scenario.day).start_ms + 6 * 3600000;
    const f = fixture({ source: scenario.source, now }), next = Date.parse(scenario.next);
    try {
      assert.equal((next - Date.parse(scenario.source)) / 3600000, scenario.hours);
      const ownClock = value(f, next, now), twoHoursLater = value(f, next + 2 * 3600000, now);
      assert.equal(ownClock.correction_factor, 1.079); assert.equal(ownClock.power_w, 1079);
      assert.equal(ownClock.correction_source, 'same_clock_quarter');
      assert.equal(ownClock.correction_reference_end, new Date(scenario.source).toISOString());
      assert.equal(twoHoursLater.correction_factor, 1); assert.equal(twoHoursLater.power_w, 1000);
      assert.equal(twoHoursLater.correction_source, 'none'); assert.equal(twoHoursLater.correction_reference_end, null);
      assert.equal(f.repository.pvBlockCorrectionPattern(f.key, now)[0].quarter_minute, 9 * 60 + 45);
    } finally { f.db.close(); }
  }
});

test('een databaseherstart behoudt de factor en oorspronkelijke UTC-referentie zonder klokverschuiving', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-correction-clock-')), path = join(folder, 'clock.sqlite');
  const source = '2026-10-29T08:45:00Z', now = Date.parse('2026-10-30T06:00:00Z'), next = Date.parse('2026-10-30T08:45:00Z');
  const f = fixture({ source, now, path });
  t.after(() => { f.db.close(); rmSync(folder, { recursive: true, force: true }); });
  const before = value(f, next, now), stored = { ...f.repository.pvBlockCorrections(f.key)[0] };
  f.db.close(); f.db = openDatabase(path); f.repository = createRepository(f.db);
  const after = value(f, next, now);
  assert.deepEqual(after, before);
  assert.equal(after.correction_reference_start, '2026-10-29T08:30:00.000Z');
  assert.equal(after.correction_reference_end, '2026-10-29T08:45:00.000Z');
  assert.equal(after.correction_computed_at, new Date(f.updated).toISOString());
  assert.deepEqual({ ...f.repository.pvBlockCorrections(f.key)[0] }, stored);
  assert.equal(value(f, next + 2 * 3600000, now).correction_source, 'none');
});

test('dezelfde correctiekwartieren en UTC-referenties blijven gelijk op servers in UTC, Amsterdam en New York', () => {
  const script = `
import { loadConfiguration } from './src/config/load.js';
import { openDatabase } from './src/storage/database.js';
import { createRepository } from './src/storage/repository.js';
import { correctionModelKey } from './src/pv/correction-key.js';
import { createPvForecastModel } from './src/pv/forecast-model.js';
import { localDayRange } from './src/weather/local-calendar.js';
${fixture.toString()}
${value.toString()}
const result = ${JSON.stringify(cases)}.map(scenario => {
  const now = localDayRange(scenario.day).start_ms + 6 * 3600000;
  const f = fixture({ source: scenario.source, now }), next = Date.parse(scenario.next);
  try { return [value(f, next, now), value(f, next + 7200000, now)]; }
  finally { f.db.close(); }
});
process.stdout.write(JSON.stringify(result));`;
  const results = ['UTC', 'Europe/Amsterdam', 'America/New_York'].map((TZ) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TZ }, encoding: 'utf8', timeout: 15000
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  });
  assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
  for (const [ownClock, later] of results[0]) {
    assert.equal(ownClock.correction_factor, 1.079); assert.equal(later.correction_factor, 1);
  }
});
