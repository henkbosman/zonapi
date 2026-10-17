import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration, validateSettings } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { estimatePv } from '../src/pv/model.js';
import { automaticCorrectionConfig } from '../src/pv/automatic-config.js';
import { correctionModelKey } from '../src/pv/correction-key.js';
import { clockQuarter, splitForecastQuarters } from '../src/pv/quarter.js';
import { createPvForecastModel } from '../src/pv/forecast-model.js';
import { learnPvCorrection } from '../src/pv/learn-correction.js';
import { refreshPvForecast } from '../src/pv/refresh-forecast.js';
import { createGrowattCloudPoller } from '../src/growatt/cloud/poller.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { startHttpServer } from '../src/api/http-server.js';

const minute = 60000, quarter = 15 * minute;
const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];

/** Bouwt een volledig geconfigureerde installatie met een vlakke basisprognose; input: optionele klok, instraling, automatisch beleid, databasepad en zaadvlag; output: modelcontext en open database. */
function fixture({ now = Date.parse('2026-10-16T10:07:00Z'), irradiance = 125, automatic = {}, path = ':memory:', seed = true } = {}) {
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, location: { latitude: 52, longitude: 5 }, http: { host: '127.0.0.1', port: 0 },
    pv: { calibration_factor: 1, automatic_correction: automatic }, growatt: { ...defaults.growatt, production_source: 'cloud', cloud: { token: 'test-token', poll_seconds: 300 } },
    advice: { ...defaults.advice, reserve_w: 0, baseload_w: 0, min_solar_share: 1 } };
  const panels = { expected_panel_count: 20, inverters: serials.map((serial, index) => ({ id: `mic-${index}`, serial, ac_limit_w: 2000 })),
    groups: serials.map((serial, index) => ({ id: `zuid-${index}`, inverter_id: `mic-${index}`, count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 })) };
  const db = openDatabase(path), repository = createRepository(db);
  if (seed) {
    db.exec('BEGIN');
    for (let at = Math.floor(now / quarter) * quarter - 2 * 3600000; at < now + 74 * 3600000; at += quarter) {
      const row = { source: 'open-meteo', model: 'icon_d2', start_ms: at, end_ms: at + quarter, ghi: irradiance, dni: 0, dhi: irradiance, fetched_ms: now - 10 * minute };
      repository.saveForecast(row);
      for (const group of estimatePv(row, panels, 52, 5).groups) repository.savePv({ ...row, ...group, computed_ms: now - 1000 });
    }
    db.exec('COMMIT');
  }
  return { db, repository, settings, panels, now };
}

/** Maakt een volledige Growatt-meetronde; input: totaalvermogen en meettijd; output: vier afzonderlijke metingen. */
function observations(power, at) {
  return serials.map((serial) => ({ serial, measured_ms: at, received_ms: at + minute, power_w: power / 4, energy_today_kwh: 1, energy_total_kwh: 100, frame_id: null }));
}

/** Leert met de vaste testinstallatie; input: context, totaalvermogen en optionele meet-/ontvangsttijd; output: leerresultaat. */
function learn(context, power, at = context.now - minute, received = context.now) {
  return learnPvCorrection(context.repository, context.settings, context.panels, [], observations(power, at), received);
}

/** Leest een effectieve voorspelling op één tijdstip; input: context, doeltijd en optionele peiltijd; output: gecorrigeerde prognose. */
function prediction(context, at, now = context.now) {
  const model = createPvForecastModel(context.repository, context.settings, context.panels, now);
  const row = model.prepare(context.repository.forecast(at, at + 1)).find((item) => item.start_ms <= at && item.end_ms > at);
  return model.estimate(row);
}

test('automatische correctie heeft configureerbare grenzen en een eigen patroon per paneelmodel', () => {
  const f = fixture({ seed: false });
  try {
    assert.equal(automaticCorrectionConfig({}).enabled, true);
    assert.equal(automaticCorrectionConfig({}).mode, 'live_today_pattern');
    for (const automatic of [null, [], { enabled: 1 }, { mode: 'other' }, { min_forecast_w: 0 }, { max_factor: 0.5 }, { max_factor: 11 }, { max_skew_seconds: -1 }]) {
      assert.ok(validateSettings({ ...f.settings, pv: { automatic_correction: automatic } }).some((error) => error.startsWith('pv.automatic_correction')));
    }
    const key = correctionModelKey(f.settings, f.panels);
    const reordered = { ...f.panels, groups: [...f.panels.groups].reverse(), inverters: [...f.panels.inverters].reverse() };
    assert.equal(correctionModelKey(f.settings, reordered), key);
    assert.notEqual(correctionModelKey({ ...f.settings, pv: { calibration_factor: 1.5 } }, f.panels), key);
    const moved = { ...f.panels, groups: f.panels.groups.map((group) => ({ ...group, tilt_deg: 20 })) };
    assert.notEqual(correctionModelKey(f.settings, moved), key);
    assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.ok(f.db.prepare('PRAGMA table_info(pv_forecast)').all().some((column) => column.name === 'base_power_w'));
  } finally { f.db.close(); }
});

test('nieuwe Growatt-waarden overschrijven hetzelfde klokkwartier zonder correcties op te stapelen of het verleden te wijzigen', () => {
  const f = fixture();
  try {
    const past = f.repository.pv(f.now - 2 * 3600000, Math.floor(f.now / quarter) * quarter);
    const raw = f.repository.forecastCandidates(f.now - 2 * 3600000, f.now + 72 * 3600000);
    assert.deepEqual(learn(f, 800), { status: 'updated', factor: 0.8, time: '12:00', correction_percent: -20 });
    const first = prediction(f, f.now + 30 * minute);
    assert.equal(first.base_power_w, 1000);
    assert.equal(first.power_w, 800);
    assert.equal(first.correction_factor, 0.8);
    assert.equal(learn(f, 800, f.now - minute, f.now + 1000).status, 'unchanged');
    assert.equal(learn(f, 600, f.now + 4 * minute, f.now + 5 * minute).factor, 0.6);
    assert.equal(prediction(f, f.now + 30 * minute, f.now + 5 * minute).power_w, 600);
    const pattern = f.repository.pvCorrectionPattern(correctionModelKey(f.settings, f.panels));
    assert.equal(pattern.length, 1);
    assert.equal(pattern[0].quarter_minute, 720);
    assert.equal(pattern[0].predicted_w, 1000);
    assert.equal(pattern[0].measured_w, 600);
    assert.deepEqual(f.repository.pv(f.now - 2 * 3600000, Math.floor(f.now / quarter) * quarter), past);
    assert.deepEqual(f.repository.forecastCandidates(f.now - 2 * 3600000, f.now + 72 * 3600000), raw);
    const cached = f.repository.pv(f.now + 30 * minute, f.now + 30 * minute + 1);
    assert.equal(cached.reduce((sum, row) => sum + row.power_w, 0), 600);
    assert.equal(cached.reduce((sum, row) => sum + row.base_power_w, 0), 1000);
    assert.ok(cached.every((row) => row.correction_factor === 0.6 && row.fetched_ms === f.now - 10 * minute && row.computed_ms === f.now + 5 * minute));
  } finally { f.db.close(); }
});

test('het kwartierpatroon geldt morgen en overmorgen; de nieuwste afwijking corrigeert alle resterende kwartieren van vandaag', () => {
  const f = fixture();
  try {
    const key = correctionModelKey(f.settings, f.panels);
    f.repository.savePvCorrection({ model_key: key, quarter_minute: 16 * 60, factor: 0.6, predicted_w: 1000, measured_w: 600,
      measured_ms: f.now - 86400000, updated_ms: f.now - 86400000, signature: 'previous-afternoon' });
    learn(f, 800);
    assert.equal(prediction(f, Date.parse('2026-10-16T14:00:00Z')).power_w, 800);
    for (const day of ['17', '18']) {
      assert.equal(prediction(f, Date.parse(`2026-10-${day}T10:00:00Z`)).power_w, 800);
      assert.equal(prediction(f, Date.parse(`2026-10-${day}T14:00:00Z`)).power_w, 600);
      assert.equal(prediction(f, Date.parse(`2026-10-${day}T10:15:00Z`)).power_w, 800);
    }
    const patterned = { ...f, settings: { ...f.settings, pv: { automatic_correction: { mode: 'pattern' } } } };
    assert.equal(prediction(patterned, Date.parse('2026-10-16T14:00:00Z')).power_w, 600);
    const disabled = { ...f, settings: { ...f.settings, pv: { automatic_correction: { enabled: false } } } };
    assert.equal(prediction(disabled, Date.parse('2026-10-16T14:00:00Z')).power_w, 1000);
    assert.equal(learn(disabled, 500).status, 'disabled');
  } finally { f.db.close(); }
});

test('leren vereist een complete, recente en samenhangende meting plus een voldoende hoge, recente basisprognose', () => {
  const f = fixture();
  try {
    const apply = (rows) => learnPvCorrection(f.repository, f.settings, f.panels, [], rows, f.now);
    assert.equal(apply(observations(800, f.now - minute).slice(0, 3)).status, 'incomplete');
    assert.equal(apply(observations(800, f.now - 13 * minute)).status, 'stale');
    assert.equal(apply(observations(800, f.now + 1)).status, 'stale');
    const skewed = observations(800, f.now - minute); skewed[0].measured_ms -= 6 * minute;
    assert.equal(apply(skewed).status, 'time_skew');
    f.db.prepare('UPDATE forecast SET fetched_ms=?').run(f.now - 5 * 3600000);
    assert.equal(apply(observations(800, f.now - minute)).status, 'forecast_stale');
    f.db.prepare('UPDATE forecast SET fetched_ms=?,ghi=1,dhi=1').run(f.now);
    assert.equal(apply(observations(800, f.now - minute)).status, 'low_forecast');
    f.db.exec('DELETE FROM forecast');
    assert.equal(apply(observations(800, f.now - minute)).status, 'forecast_unavailable');
    assert.equal(f.repository.pvCorrectionPattern(correctionModelKey(f.settings, f.panels)).length, 0);
  } finally { f.db.close(); }
});

test('nulopwek kan een correctie opleveren en een volgende meting herstelt zonder delen door nul', () => {
  const f = fixture();
  try {
    assert.equal(learn(f, 0).factor, 0);
    assert.equal(prediction(f, f.now + 30 * minute).power_w, 0);
    assert.equal(learn(f, 800, f.now + 4 * minute, f.now + 5 * minute).factor, 0.8);
    assert.equal(prediction(f, f.now + 30 * minute, f.now + 5 * minute).power_w, 800);
    assert.equal(learn(f, 600, f.now - 5 * minute, f.now + 6 * minute).status, 'older_measurement');
  } finally { f.db.close(); }
});

test('automatische correcties respecteren handmatige kalibratie, maximumfactor en fysieke AC-limieten', () => {
  const f = fixture({ irradiance: 2000 });
  try {
    assert.equal(learn(f, 4000).factor, 0.5);
    assert.equal(prediction(f, f.now + 30 * minute).base_power_w, 8000);
    assert.equal(prediction(f, f.now + 30 * minute).power_w, 4000);
    assert.equal(learn(f, 24000, f.now + 4 * minute, f.now + 5 * minute).factor, 3);
    assert.equal(prediction(f, f.now + 30 * minute, f.now + 5 * minute).power_w, 8000);
  } finally { f.db.close(); }
  const manual = fixture();
  try {
    manual.settings.pv.calibration_factor = 1.78;
    assert.equal(learn(manual, 800).factor, 0.449438);
    assert.equal(prediction(manual, manual.now + 30 * minute).base_power_w, 1780);
    assert.equal(prediction(manual, manual.now + 30 * minute).power_w, 800);
  } finally { manual.db.close(); }
});

test('patroon en cacheherberekening worden samen teruggedraaid bij een opslagfout', (t) => {
  const f = fixture();
  try {
    const before = f.repository.pv(f.now, f.now + 3600000);
    t.mock.method(f.repository, 'savePv', () => { throw new Error('opslagfout'); });
    assert.throws(() => learn(f, 800), /opslagfout/);
    assert.deepEqual(f.repository.pvCorrectionPattern(correctionModelKey(f.settings, f.panels)), []);
    assert.deepEqual(f.repository.pv(f.now, f.now + 3600000), before);
  } finally { f.db.close(); }
});

test('klokkwartieren blijven op xx:00/15/30/45 rond wintertijd en uurdata behoudt zijn bronmiddelpunt', () => {
  assert.equal(clockQuarter(Date.parse('2026-10-25T00:07:00Z')), 120);
  assert.equal(clockQuarter(Date.parse('2026-10-25T01:07:00Z')), 120);
  assert.equal(clockQuarter(Date.parse('2026-10-25T02:17:00Z')), 195);
  const f = fixture({ now: Date.parse('2026-10-25T00:07:00Z') });
  try {
    learn(f, 800);
    learn(f, 600, f.now + 59 * minute, f.now + 60 * minute);
    const pattern = f.repository.pvCorrectionPattern(correctionModelKey(f.settings, f.panels));
    assert.equal(pattern.length, 1);
    assert.equal(pattern[0].quarter_minute, 120);
    assert.equal(pattern[0].factor, 0.6);
    assert.throws(() => f.repository.savePvCorrection({ ...pattern[0], quarter_minute: 121, signature: 'invalid' }), /CHECK/);
  } finally { f.db.close(); }
  const start = Date.parse('2026-10-18T10:00:00Z');
  const parts = splitForecastQuarters([{ start_ms: start, end_ms: start + 3600000, ghi: 123 }]);
  assert.equal(parts.length, 4);
  assert.ok(parts.every((row) => row.sample_start_ms === start && row.sample_end_ms === start + 3600000 && row.source_resolution_minutes === 60));
  assert.deepEqual(parts.map((row) => new Date(row.start_ms).getUTCMinutes()), [0, 15, 30, 45]);
});

test('een nieuwe weeropvraag behoudt de correctie, daarna leert Growatt opnieuw tegen de vernieuwde basis', async () => {
  const f = fixture();
  let now = f.now + minute, requests = 0;
  try {
    learn(f, 800);
    const weather = createWeatherScheduler({ settings: f.settings, panels: f.panels, panelErrors: [], repository: f.repository, clock: () => now,
      source: async () => { requests++; return { rows: f.repository.forecastCandidates(f.now - 2 * 3600000, f.now + 72 * 3600000).map((row) => ({ ...row, ghi: 250, dhi: 250, fetched_ms: now })),
        sun: [{ day: '2026-10-16', sunrise_ms: Date.parse('2026-10-16T06:00:00Z'), sunset_ms: Date.parse('2026-10-16T17:00:00Z') }] }; } });
    assert.equal((await weather.refresh()).reason, 'ok');
    assert.equal(prediction(f, now + 30 * minute, now).base_power_w, 2000);
    assert.equal(prediction(f, now + 30 * minute, now).power_w, 1600);
    now += 4 * minute;
    assert.equal(learn(f, 800, now - minute, now).factor, 0.4);
    assert.equal(prediction(f, now + 30 * minute, now).power_w, 800);
    assert.equal(requests, 1);
    const cached = f.repository.pv(now + 30 * minute, now + 30 * minute + 1);
    assert.equal(cached.reduce((sum, row) => sum + row.power_w, 0), 800);
  } finally { f.db.close(); }
});

test('kwartierpatronen blijven bewaard na logs wissen, uitschakelen en herstart met dezelfde instellingen', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-pattern-')), path = join(folder, 'state.sqlite');
  const f = fixture({ path });
  let closed = false;
  try {
    f.repository.setLogging('growatt', false);
    learn(f, 800);
    f.repository.clearGrowattDiagnostics();
    f.db.close(); closed = true;
    const db = openDatabase(path);
    try {
      const repository = createRepository(db), restarted = { ...f, db, repository };
      assert.equal(prediction(restarted, f.now + 2 * 86400000).power_w, 800);
      assert.equal(repository.loggingStatus('growatt').enabled, false);
      assert.equal(createPvForecastModel(repository, f.settings, f.panels, f.now).status().learned_quarters, 1);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { db.close(); }
  } finally { if (!closed) f.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('uurterugval overmorgen krijgt vier verschillende kwartiercorrecties in API-model en databasecache', () => {
  const f = fixture();
  try {
    const modelKey = correctionModelKey(f.settings, f.panels);
    for (const [minuteOfDay, factor] of [[735, 0.5], [750, 0.7], [765, 0.9]]) f.repository.savePvCorrection({
      model_key: modelKey, quarter_minute: minuteOfDay, factor, predicted_w: 1000, measured_w: factor * 1000,
      measured_ms: f.now - 86400000, updated_ms: f.now - 86400000, signature: `previous-${minuteOfDay}` });
    learn(f, 800);
    const start = Date.parse('2026-10-18T10:00:00Z');
    f.repository.saveForecast({ source: 'open-meteo', model: 'best_match', start_ms: start, end_ms: start + 3600000,
      ghi: 125, dni: 0, dhi: 125, fetched_ms: f.now + 1000 });
    const model = createPvForecastModel(f.repository, f.settings, f.panels, f.now + 2000);
    const rows = model.prepare(f.repository.forecast(start, start + 3600000));
    assert.deepEqual(rows.map((row) => model.estimate(row).power_w), [800, 500, 700, 900]);
    assert.ok(rows.every((row) => row.source_resolution_minutes === 60 && row.sample_start_ms === start && row.sample_end_ms === start + 3600000));
    refreshPvForecast(f.repository, f.settings, f.panels, [], f.now + 2000);
    const cached = f.repository.pv(start, start + 3600000), byQuarter = new Map();
    for (const row of cached) byQuarter.set(row.start_ms, (byQuarter.get(row.start_ms) ?? 0) + row.power_w);
    assert.deepEqual([...byQuarter.values()], [800, 500, 700, 900]);
    assert.equal(cached.length, 16);
  } finally { f.db.close(); }
});

test('Growatt-opvragen corrigeren API, daggrafiek, cache en apparaatadviezen; een gedeeltelijke cyclus leert niet', async (t) => {
  const f = fixture({ irradiance: 500 });
  let now = f.now, total = 800, reads = 0, cycles = 0, fail = false;
  t.mock.method(Date, 'now', () => now);
  const cloud = createGrowattCloudPoller({ settings: f.settings, panels: f.panels, repository: f.repository, environment: {}, clock: () => now,
    client: { read: async (device) => { reads++; if (fail && device.serial === serials[2]) throw new Error('testfout'); return observations(total, now - minute).find((row) => row.serial === device.serial); } },
    onMeasurements: (rows, at) => { cycles++; return learnPvCorrection(f.repository, f.settings, f.panels, [], rows, at); } });
  const server = startHttpServer({ ...f, panelErrors: [], growattCloud: cloud,
    weather: { status: () => ({ sunrise: '2026-10-16T06:00:00Z', sunset: '2026-10-16T17:00:00Z' }) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => (await fetch(base + path)).json();
    assert.equal((await get('/api/v1/appliances/wasmachine/advice')).can_start_now, true);
    const first = await (await fetch(`${base}/api/v1/growatt/cloud/poll`, { method: 'POST' })).json();
    assert.equal(first.forecast_correction.factor, 0.2);
    assert.equal(reads, 4); assert.equal(cycles, 1);
    const forecast = await get('/api/v1/forecast?hours=3');
    assert.ok(forecast.slots.every((row) => row.power_w === 800 && row.base_power_w === 4000 && row.automatic_correction_factor === 0.2));
    const day = await get('/api/v1/forecast/day');
    assert.ok(day.slots.filter((row) => Date.parse(row.end) <= now).every((row) => row.power_w === 4000));
    assert.ok(day.slots.filter((row) => Date.parse(row.start) >= now).every((row) => row.power_w === 800));
    const pattern = await get('/api/v1/pv/corrections');
    assert.equal(pattern.quarters.length, 96);
    assert.equal(pattern.learned_quarters, 1);
    assert.equal(pattern.latest.correction_percent, -80);
    assert.equal((await get('/api/v1/appliances/wasmachine/advice')).can_start_now, false);
    assert.ok((await get('/api/v1/appliances/daily')).days.every((day) => day.appliances.find((item) => item.id === 'wasmachine').earliest_start === null));
    const later = await get('/api/v1/forecast?hours=72');
    assert.ok(later.slots.some((row) => Date.parse(row.start) > now + 2 * 86400000));
    assert.ok(later.slots.every((row) => row.power_w === 800));
    await fetch(`${base}/api/v1/growatt/logging?enabled=false`, { method: 'PUT' });
    await fetch(`${base}/api/v1/growatt/diagnostics`, { method: 'DELETE' });
    assert.equal((await get('/api/v1/pv/corrections')).learned_quarters, 1);
    now += 5 * minute; total = 400;
    assert.equal((await cloud.poll()).forecast_correction.factor, 0.1);
    assert.equal((await get('/api/v1/pv/corrections')).learned_quarters, 1);
    now += 5 * minute; fail = true;
    assert.equal((await cloud.poll()).reason, 'partial');
    assert.equal(cycles, 2);
    assert.equal((await get('/api/v1/pv/corrections')).learned_quarters, 1);
    assert.equal((await get('/api/v1/pv/corrections')).latest.factor, 0.1);
    assert.equal((await get('/api/v1/growatt/cloud')).forecast_correction.status, 'incomplete');
    const source = await get('/api/v1/production/current');
    assert.equal(source.inverters.length, 4);
    assert.ok(source.inverters.every((row) => [100, 200].includes(row.power_w)));
  } finally { await new Promise((resolve) => server.close(resolve)); await cloud.stop(); f.db.close(); }
});
