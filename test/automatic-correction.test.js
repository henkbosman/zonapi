import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration, validateSettings } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { automaticCorrectionConfig } from '../src/pv/automatic-config.js';
import { correctionModelKey } from '../src/pv/correction-key.js';
import { clockQuarter, splitForecastQuarters } from '../src/pv/quarter.js';
import { createPvForecastModel } from '../src/pv/forecast-model.js';
import { learnPvCorrection } from '../src/pv/learn-correction.js';
import { refreshPvForecast } from '../src/pv/refresh-forecast.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { startHttpServer } from '../src/api/http-server.js';
import { renderPvCorrection } from '../public/pv-correction-status.js';

const minute = 60000, quarter = 900000;
const target = Date.parse('2026-10-18T12:15:00Z'); // 14:00–14:15 in Nederland.
const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];

/** Bouwt een installatie met een vlakke basisprognose en echte SQLite-opslag; input: testcontext en opties; output: helpers voor afzonderlijke blokken. */
function fixture(t, { automatic = {}, path = ':memory:', irradiance = 125, center = target } = {}) {
  const { settings } = loadConfiguration();
  settings.location = { latitude: 52, longitude: 5 }; settings.http = { host: '127.0.0.1', port: 0 };
  settings.pv = { calibration_factor: 1, automatic_correction: automatic };
  settings.growatt.production_source = 'cloud';
  settings.advice = { ...settings.advice, baseload_w: 0, reserve_w: 0, min_solar_share: 1 };
  const panels = { expected_panel_count: 20, inverters: serials.map((serial, index) => ({ id: `mic-${index}`, serial, ac_limit_w: 2000 })),
    groups: serials.map((_, index) => ({ id: `zuid-${index}`, inverter_id: `mic-${index}`, count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 })) };
  const f = { settings, panels, db: openDatabase(path), target: center, now: center + 10 * minute };
  f.repository = createRepository(f.db);
  for (let start = center - 2 * 3600000; start < center + 75 * 3600000; start += quarter) f.repository.saveForecast({ source: 'open-meteo', model: 'icon_d2',
    start_ms: start, end_ms: start + quarter, ghi: irradiance, dni: 0, dhi: irradiance, fetched_ms: center - 10 * minute });
  refreshPvForecast(f.repository, settings, panels, [], f.now);
  f.blocks = () => f.repository.pvBlockCorrections(correctionModelKey(settings, panels));
  f.learn = (power, end = f.target, at = Math.max(f.now, end + 10 * minute)) => {
    f.now = at;
    return learnPvCorrection(f.repository, settings, panels, [], serials.map((serial) => ({ serial, source: 'cloud', power_w: power / 4,
      measured_ms: end + 5 * minute + 1000, received_ms: at })), at, { target_ms: end });
  };
  f.value = (end, now = f.now) => {
    const model = createPvForecastModel(f.repository, settings, panels, now);
    const row = model.prepare(f.repository.forecast(end - 1, end)).find((item) => item.end_ms === end);
    assert.ok(row, 'Voorspelblok ontbreekt'); return model.estimate(row);
  };
  t.after(() => f.db.close());
  return f;
}

test('per_block is de standaard; bestaande modi worden zonder configuratieaanpassing onafhankelijk', (t) => {
  const f = fixture(t);
  for (const mode of [undefined, 'per_block', 'live_today_pattern', 'pattern']) {
    const settings = { ...f.settings, pv: { automatic_correction: mode ? { mode } : {} } };
    assert.equal(automaticCorrectionConfig(settings).mode, 'per_block');
    assert.deepEqual(validateSettings(settings), []);
  }
  for (const value of [{ mode: 'unknown' }, { enabled: 1 }, { max_factor: 0 }, { max_skew_seconds: -1 }, { min_forecast_w: 0 }]) {
    assert.ok(validateSettings({ ...f.settings, pv: { automatic_correction: value } }).some((error) => error.startsWith('pv.automatic_correction')));
  }
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 6);
  const reordered = { ...f.panels, inverters: [...f.panels.inverters].reverse(), groups: [...f.panels.groups].reverse() };
  assert.equal(correctionModelKey(f.settings, reordered), correctionModelKey(f.settings, f.panels));
});

test('14:15-correctie wijzigt uitsluitend 14:00–14:15 in model en cache; volgende dag en buurblokken blijven exact gelijk', (t) => {
  const f = fixture(t), before = f.repository.pv(f.target - 2 * quarter, f.target + 2 * 86400000).map((row) => ({ ...row }));
  assert.equal(f.learn(600).factor, 0.6);
  assert.equal(f.value(target).power_w, 600); assert.equal(f.value(target).correction_source, 'block');
  for (const end of [target - quarter, target + quarter, target + 2 * quarter, target + 86400000, target + 2 * 86400000]) {
    assert.equal(f.value(end).power_w, 1000); assert.equal(f.value(end).correction_factor, 1); assert.equal(f.value(end).correction_source, 'none');
  }
  const after = f.repository.pv(f.target - 2 * quarter, f.target + 2 * 86400000);
  assert.deepEqual(after.filter((row) => row.end_ms !== target), before.filter((row) => row.end_ms !== target));
  const own = after.filter((row) => row.end_ms === target);
  assert.equal(own.reduce((sum, row) => sum + row.power_w, 0), 600);
  assert.ok(own.every((row) => row.correction_factor === 0.6));
  const signature = f.blocks()[0].signature;
  assert.equal(f.learn(600).status, 'unchanged'); assert.equal(f.blocks()[0].signature, signature); assert.equal(f.blocks().length, 1);
  assert.equal(f.blocks()[0].start_ms, target - quarter); assert.equal(f.blocks()[0].end_ms, target);
});

test('twee opeenvolgende blokken hebben verschillende factoren; opnieuw leren in het ene blok wijzigt het andere niet', (t) => {
  const f = fixture(t);
  f.learn(600); f.learn(900, target + quarter);
  const second = { ...f.blocks()[1] };
  assert.equal(f.learn(700, target, f.now + 1000).status, 'updated');
  assert.equal(f.value(target).power_w, 700); assert.equal(f.value(target + quarter).power_w, 900);
  assert.deepEqual({ ...f.blocks()[1] }, second); assert.equal(f.blocks().length, 2);
  assert.equal(f.value(target + 2 * quarter).power_w, 1000);
});

test('een nieuwere correctie in een ander blok verhindert het later verwerken van een eerder blok niet', (t) => {
  const f = fixture(t);
  f.learn(800, target + quarter); assert.equal(f.learn(600, target, f.now + 1000).status, 'updated');
  assert.equal(f.blocks().length, 2); assert.equal(f.value(target).power_w, 600); assert.equal(f.value(target + quarter).power_w, 800);
});

test('nulopwek is een geldige eigen correctie en zet geen enkel later blok op nul', (t) => {
  const f = fixture(t); assert.equal(f.learn(0).factor, 0);
  assert.equal(f.value(target).power_w, 0); assert.equal(f.value(target + quarter).power_w, 1000);
  assert.equal(f.learn(800, target, f.now + 1000).factor, 0.8);
  assert.equal(f.value(target).power_w, 800); assert.equal(f.value(target + quarter).power_w, 1000);
});

test('dezelfde kloktijd op de volgende dag krijgt een eigen correctierij en bewaart de correctie van gisteren', (t) => {
  const f = fixture(t); f.learn(600);
  const next = target + 86400000;
  f.repository.saveForecast({ source: 'open-meteo', model: 'icon_d2', start_ms: next - quarter, end_ms: next,
    ghi: 125, dni: 0, dhi: 125, fetched_ms: next });
  assert.equal(f.learn(900, next).status, 'updated');
  assert.equal(f.blocks().length, 2); assert.equal(f.value(target).power_w, 600); assert.equal(f.value(next).power_w, 900);
  assert.equal(f.value(next + quarter).power_w, 1000);
});

test('uitschakelen of wijzigen van het paneelmodel past bestaande blokfactoren niet toe op andere waarden', (t) => {
  const f = fixture(t); f.learn(600);
  f.settings.pv.automatic_correction = { enabled: false };
  assert.equal(f.learn(800).status, 'disabled'); assert.equal(f.blocks().length, 1); assert.equal(f.value(target).power_w, 1000);
  f.settings.pv = { calibration_factor: 1.5 };
  assert.equal(f.value(target).power_w, 1500); assert.equal(f.value(target + quarter).power_w, 1500);
  assert.equal(createPvForecastModel(f.repository, f.settings, f.panels, f.now).status().learned_blocks, 0);
});

test('handmatige kalibratie en AC-limieten blijven gelden binnen het eigen blok', (t) => {
  const f = fixture(t, { irradiance: 2000 });
  assert.equal(f.learn(4000).factor, 0.5); assert.equal(f.value(target).power_w, 4000);
  assert.equal(f.value(target + quarter).power_w, 8000);
  assert.equal(f.learn(24000, target, f.now + 1000).factor, 3); assert.equal(f.value(target).power_w, 8000);
  const manual = fixture(t); manual.settings.pv.calibration_factor = 1.78;
  assert.equal(manual.learn(800).factor, 0.449438);
  assert.equal(manual.value(target).base_power_w, 1780); assert.equal(manual.value(target).power_w, 800);
  assert.equal(manual.value(target + quarter).power_w, 1780);
});

test('onvolledige, oude of toekomstige metingen en een ontbrekende of te lage basis maken geen correctie', (t) => {
  const f = fixture(t);
  const rows = serials.map((serial) => ({ serial, source: 'cloud', power_w: 200, measured_ms: target + 5 * minute }));
  const learn = (values) => learnPvCorrection(f.repository, f.settings, f.panels, [], values, f.now, { target_ms: target });
  assert.equal(learn(rows.slice(0, 3)).status, 'incomplete');
  assert.equal(learn(rows.map((row) => ({ ...row, measured_ms: f.now - 21 * minute }))).status, 'stale');
  assert.equal(learn(rows.map((row) => ({ ...row, measured_ms: f.now + 1 }))).status, 'stale');
  assert.equal(learn([{ ...rows[0], measured_ms: target - 2 * minute }, ...rows.slice(1)]).status, 'time_skew');
  f.db.prepare('UPDATE forecast SET fetched_ms=?').run(f.now - 5 * 3600000); assert.equal(learn(rows).status, 'forecast_stale');
  f.db.prepare('UPDATE forecast SET fetched_ms=?,ghi=1,dhi=1').run(f.now); assert.equal(learn(rows).status, 'low_forecast');
  f.db.exec('DELETE FROM forecast'); assert.equal(learn(rows).status, 'forecast_unavailable'); assert.equal(f.blocks().length, 0);
});

test('opslag van correctie en het bijbehorende cacheblok is één transactie', (t) => {
  const f = fixture(t), before = f.repository.pv(target - quarter, target + quarter);
  t.mock.method(f.repository, 'savePv', () => { throw new Error('opslagfout'); });
  assert.throws(() => f.learn(800), /opslagfout/);
  assert.equal(f.blocks().length, 0); assert.deepEqual(f.repository.pv(target - quarter, target + quarter), before);
});

test('nieuwe weerdata behoudt de eigen correctiereferentie, zonder de omliggende blokken te corrigeren', async (t) => {
  const f = fixture(t); f.learn(800); f.now += minute;
  const weather = createWeatherScheduler({ ...f, panelErrors: [], clock: () => f.now, source: async () => ({
    rows: f.repository.forecastCandidates(target - 2 * 3600000, target + 72 * 3600000).map((row) => ({ ...row, ghi: 250, dhi: 250, fetched_ms: f.now })), sun: [] }) });
  assert.equal((await weather.refresh()).reason, 'ok'); assert.equal(f.value(target).power_w, 800); assert.equal(f.value(target).base_power_w, 1000);
  assert.equal(f.value(target + quarter).power_w, 2000); assert.equal(f.value(target + quarter).correction_factor, 1);
  assert.equal(f.learn(800, target, f.now + 1000).factor, 0.4);
  assert.equal(f.value(target).power_w, 800); assert.equal(f.value(target).base_power_w, 2000);
  assert.equal(f.value(target + quarter).power_w, 2000);
});

test('uurterugval wordt voor één eigen correctie gesplitst; de drie overige kwartieren blijven ongecorrigeerd', (t) => {
  const f = fixture(t), start = target - quarter;
  f.db.prepare('DELETE FROM forecast WHERE start_ms>=? AND start_ms<?').run(start, start + 3600000);
  f.repository.saveForecast({ source: 'open-meteo', model: 'best_match', start_ms: start, end_ms: start + 3600000, ghi: 125, dni: 0, dhi: 125, fetched_ms: f.now });
  f.learn(600);
  const model = createPvForecastModel(f.repository, f.settings, f.panels, f.now), rows = model.prepare(f.repository.forecast(start, start + 3600000));
  assert.deepEqual(rows.map((row) => model.estimate(row).power_w), [600, 1000, 1000, 1000]);
  assert.ok(rows.every((row) => row.source_resolution_minutes === 60 && row.sample_start_ms === start && row.sample_end_ms === start + 3600000));
  assert.equal(splitForecastQuarters([{ start_ms: start, end_ms: start + 3600000 }]).length, 4);
});

test('gelijke kloktijden op andere dagen en beide wintertijduren blijven aparte correcties', (t) => {
  const first = Date.parse('2026-10-25T00:15:00Z'), f = fixture(t, { center: first });
  assert.equal(clockQuarter(first), clockQuarter(first + 3600000));
  f.learn(600, first); f.learn(900, first + 3600000);
  assert.equal(f.blocks().length, 2); assert.equal(f.value(first).power_w, 600); assert.equal(f.value(first + 3600000).power_w, 900);
  const status = createPvForecastModel(f.repository, f.settings, f.panels, f.now).status();
  assert.equal(status.total_blocks_in_day, 100); assert.equal(status.quarters.filter((row) => row.factor !== null).length, 2);
  assert.equal(f.value(first + 86400000).power_w, 1000);
});

test('herstart, logging uit en logs wissen behouden de onafhankelijke gedateerde correcties', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-block-restart-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const f = fixture(t, { path: join(folder, 'data.sqlite') }); f.learn(600); f.repository.setLogging('growatt', false); f.repository.clearGrowattDiagnostics();
  f.db.close(); f.db = openDatabase(join(folder, 'data.sqlite')); f.repository = createRepository(f.db);
  assert.equal(f.value(target).power_w, 600); assert.equal(f.value(target + quarter).power_w, 1000); assert.equal(f.value(target + 86400000).power_w, 1000);
  assert.equal(f.repository.loggingStatus('growatt').enabled, false);
  const display = {}; renderPvCorrection(display, createPvForecastModel(f.repository, f.settings, f.panels, f.now).status());
  assert.match(display.textContent, /Blok 14:00–14:15/); assert.match(display.textContent, /Blokken vandaag 1\/96/);
});

test('API, daggrafiek, cache en startadvies gebruiken dezelfde onafhankelijke blokken', async (t) => {
  const f = fixture(t, { irradiance: 500 }); t.mock.method(Date, 'now', () => f.now);
  const server = startHttpServer({ ...f, panelErrors: [], weather: { status: () => ({ sunrise: '2026-10-18T06:00:00Z', sunset: '2026-10-18T17:00:00Z' }) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening'); t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, get = async (path) => (await fetch(base + path)).json();
  const beforeAdvice = await get('/api/v1/appliances/wasmachine/advice'), beforeDaily = await get('/api/v1/appliances/daily');
  f.learn(800);
  const forecast = await get('/api/v1/forecast?hours=72');
  assert.ok(forecast.slots.every((row) => row.power_w === 4000 && row.base_power_w === 4000 && row.automatic_correction_factor === 1));
  const day = await get('/api/v1/forecast/day'), own = day.slots.filter((row) => Date.parse(row.end) === target);
  assert.equal(own.length, 1); assert.equal(own[0].power_w, 800); assert.equal(own[0].automatic_correction_factor, 0.2);
  assert.ok(day.slots.filter((row) => Date.parse(row.end) !== target).every((row) => row.power_w === 4000));
  assert.deepEqual(await get('/api/v1/appliances/wasmachine/advice'), beforeAdvice); assert.deepEqual(await get('/api/v1/appliances/daily'), beforeDaily);
  const corrections = await get('/api/v1/pv/corrections');
  assert.equal(corrections.scope, 'dated_block'); assert.equal(corrections.latest.start, new Date(target - quarter).toISOString());
  assert.equal(corrections.latest.end, new Date(target).toISOString()); assert.equal(corrections.learned_blocks_today, 1);
  assert.equal((await get('/api/v1/database/rows?table=pv_block_corrections')).total_rows, 1);
});
