import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { loadConfiguration, validateSettings } from '../src/config/load.js';
import { getWeatherResolution } from '../src/weather/resolution.js';
import { fetchOpenMeteo, forecastUrl, normalizeOpenMeteo } from '../src/weather/open-meteo-client.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { localDay } from '../src/weather/local-day.js';
import { estimatePv } from '../src/pv/model.js';
import { refreshPvForecast } from '../src/pv/refresh-forecast.js';
import { startHttpServer } from '../src/api/http-server.js';
import { advise } from '../src/appliances/start-advice.js';
import { dailyAdvice } from '../src/appliances/daily-advice.js';
import { forecastLinePoints, lineValueAt, canConnectPoints } from '../public/production-chart-series.js';

const minute = 60000;

/** Maakt een horizontale 1000Wp-testinstallatie; input: geen; output: panelenconfiguratie met één groep. */
function panelsFixture() {
  return { expected_panel_count: 2, inverters: [{ id: 'mic', serial: '', ac_limit_w: 2000 }],
    groups: [{ id: 'zuid', inverter_id: 'mic', count: 2, wp_per_panel: 500, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 }] };
}

/** Maakt een broninterval; input: start-ms, duur-minuten, instraling en ophaaltijd; output: weerrij. */
function row(start, duration = 60, power = 100, fetched = 1) {
  return { source: 'open-meteo', model: duration === 15 ? 'icon_d2' : 'best_match',
    start_ms: start, end_ms: start + duration * minute, ghi: power, dni: 0, dhi: power, fetched_ms: fetched };
}

/** Maakt een Open-Meteo-antwoord met beide modellen en ontbrekende kwartieren; input: uurstart-ms; output: JSON met verschillende modelwaarden en vier uur dekking. */
function payload(start) {
  return {
    hourly: { time: [1, 2, 3, 4].map((hour) => start / 1000 + hour * 3600),
      shortwave_radiation_best_match: [100, 100, 100, 100], direct_normal_irradiance_best_match: [0, 0, 0, 0], diffuse_radiation_best_match: [100, 100, 100, 100],
      shortwave_radiation_icon_d2: [999, 999, 999, 999], direct_normal_irradiance_icon_d2: [0, 0, 0, 0], diffuse_radiation_icon_d2: [999, 999, 999, 999] },
    minutely_15: { time: [1, 2, 3, 4, 5].map((quarter) => start / 1000 + quarter * 900),
      shortwave_radiation_icon_d2: [0, 500, null, 200, null], direct_normal_irradiance_icon_d2: [0, 0, null, 0, null], diffuse_radiation_icon_d2: [0, 500, null, 200, null],
      shortwave_radiation_best_match: [999, 999, 999, 999, 999], direct_normal_irradiance_best_match: [0, 0, 0, 0, 0], diffuse_radiation_best_match: [999, 999, 999, 999, 999] },
    daily: { sunrise_best_match: [start / 1000 - 4 * 3600], sunset_best_match: [start / 1000 + 8 * 3600] }
  };
}

test('kwartiermodus is standaard, blijft optioneel en vraagt beide resoluties in één HTTP-verzoek', async () => {
  const { settings } = loadConfiguration();
  const legacy = { ...settings, weather: { ...settings.weather } };
  delete legacy.weather.resolution_minutes;
  assert.equal(getWeatherResolution(legacy), 15);
  assert.deepEqual(validateSettings(legacy), []);
  for (const value of [15, 60]) assert.deepEqual(validateSettings({ ...legacy, weather: { ...legacy.weather, resolution_minutes: value } }), []);
  for (const value of [null, '15', 0, 30, false]) assert.ok(validateSettings({ ...legacy, weather: { ...legacy.weather, resolution_minutes: value } }).some((error) => error.includes('weather.resolution_minutes')));
  const url = forecastUrl(52, 5, 3);
  assert.equal(url.searchParams.get('models'), 'best_match,icon_d2');
  assert.deepEqual(url.searchParams.get('hourly').split(',').slice(0, 3), url.searchParams.get('minutely_15').split(','));
  assert.ok(url.searchParams.get('hourly').includes('cloud_cover,weather_code'));
  assert.equal(url.searchParams.get('forecast_minutely_15'), '192');
  assert.equal(url.searchParams.get('past_minutely_15'), '96');
  const hourUrl = forecastUrl(52, 5, 3, 60);
  assert.equal(hourUrl.searchParams.has('minutely_15'), false);
  assert.equal(hourUrl.searchParams.has('models'), false);
  let requests = 0;
  const result = await fetchOpenMeteo({ latitude: 52, longitude: 5, days: 3, fetcher: async (target) => {
    requests++;
    assert.equal(target.toString(), url.toString());
    return Response.json(payload(Date.parse('2026-10-16T10:00:00Z')));
  } });
  assert.equal(requests, 1);
  assert.equal(result.rows.length, 7);
  assert.equal(result.request.http_status, 200);
});

test('normalisatie kiest native ICON-kwartieren, houdt UTC rond wintertijd en gebruikt uurterugval voor nullwaarden', () => {
  const start = Date.parse('2026-10-25T01:00:00Z');
  const data = normalizeOpenMeteo(payload(start), 2000);
  const quarters = data.rows.filter((item) => item.model === 'icon_d2');
  assert.deepEqual(quarters.map((item) => [item.start_ms - start, item.end_ms - start, item.ghi]), [[0, 15 * minute, 0], [15 * minute, 30 * minute, 500], [45 * minute, 60 * minute, 200]]);
  assert.ok(data.rows.filter((item) => item.model === 'best_match').every((item) => item.ghi === 100));
  assert.equal(localDay(quarters[0].start_ms), '2026-10-25');
  const noQuarters = payload(start);
  delete noQuarters.minutely_15;
  assert.equal(normalizeOpenMeteo(noQuarters, 2000).rows.length, 4);
  const invalid = payload(start);
  invalid.minutely_15.diffuse_radiation_icon_d2.pop();
  assert.throws(() => normalizeOpenMeteo(invalid, 2000), /Onvolledige Open-Meteo-kwartierreeks/);
  const noSun = payload(start);
  noSun.daily.sunrise_best_match = [null];
  assert.deepEqual(normalizeOpenMeteo(noSun, 2000).sun, []);
});

test('opslag kiest nieuwere gegevens en telt overlappende uur- en kwartierwaarden nooit dubbel', () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const start = Date.parse('2026-10-16T10:00:00Z');
  try {
    for (const item of normalizeOpenMeteo(payload(start), 2000).rows) repository.saveForecast(item);
    const resolved = repository.forecast(start, start + 2 * 60 * minute);
    assert.deepEqual(resolved.map((item) => [item.start_ms - start, item.end_ms - start, item.ghi, item.source_resolution_minutes]),
      [[0, 15 * minute, 0, 15], [15 * minute, 30 * minute, 500, 15], [30 * minute, 45 * minute, 100, 60], [45 * minute, 60 * minute, 200, 15], [60 * minute, 120 * minute, 100, 60]]);
    assert.equal(resolved.reduce((sum, item) => sum + item.end_ms - item.start_ms, 0), 120 * minute);
    const history = repository.history('irradiance', start + 32 * minute, start + 40 * minute, 20);
    assert.equal(history.length, 1);
    assert.equal(history[0].source_resolution_minutes, 60);
    repository.saveForecast(row(start, 60, 300, 3000));
    repository.saveForecast(row(start + 15 * minute, 15, 999, 1500));
    assert.deepEqual(repository.forecast(start, start + 60 * minute).map((item) => item.ghi), [300]);
    repository.saveForecast(row(start + 15 * minute, 15, 600, 4000));
    const newest = repository.forecast(start, start + 60 * minute);
    assert.deepEqual(newest.map((item) => item.ghi), [300, 600, 300]);
    assert.equal(newest.reduce((sum, item) => sum + item.end_ms - item.start_ms, 0), 60 * minute);
    assert.equal(repository.history('irradiance', start, start + 240 * minute, 2).length, 2);
  } finally { db.close(); }
});

test('PV-cache en herberekening behouden bronmiddelpunt en selectie onafhankelijk per paneelgroep', () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, location: { latitude: 52, longitude: 5 }, pv: { calibration_factor: 1.78 } };
  const start = Date.parse('2026-10-16T10:00:00Z');
  const panels = panelsFixture();
  panels.groups[0].tilt_deg = 14;
  const hour = { ...row(start, 60, 200, 2000), dni: 300, dhi: 100 };
  try {
    for (const item of [hour, row(start, 15, 50, 2000), row(start + 45 * minute, 15, 400, 2000)]) repository.saveForecast(item);
    assert.equal(refreshPvForecast(repository, settings, panels, [], start), 3);
    const weather = repository.forecast(start, start + 60 * minute);
    const cached = repository.pv(start, start + 60 * minute);
    assert.deepEqual(cached.map((item) => item.power_w), weather.map((item) => estimatePv(item, panels, 52, 5, 1.78).power_w));
    assert.equal(cached[1].power_w, estimatePv(hour, panels, 52, 5, 1.78).power_w);
    assert.equal(repository.forecastCandidates(start, start + 60 * minute).length, 3);
    repository.savePv({ ...hour, group_id: 'oost', power_w: 77, gti_w_m2: 100 });
    const allGroups = repository.history('pv_forecast', start, start + 60 * minute, 20);
    assert.equal(allGroups.filter((item) => item.group_id === 'oost').length, 1);
    assert.equal(allGroups.filter((item) => item.group_id === 'zuid').length, 3);
  } finally { db.close(); }
});

test('bestaande databases migreren zonder verlies van uurhistorie en bewaren nieuwe modelnamen na herstart', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-quarters-'));
  const path = join(folder, 'legacy.sqlite');
  let db;
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE forecast(source TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,ghi REAL NOT NULL,dni REAL NOT NULL,dhi REAL NOT NULL,fetched_ms INTEGER NOT NULL,PRIMARY KEY(start_ms,end_ms));
      CREATE TABLE pv_forecast(group_id TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,source TEXT NOT NULL,power_w REAL NOT NULL,gti_w_m2 REAL NOT NULL,fetched_ms INTEGER NOT NULL,PRIMARY KEY(group_id,start_ms,end_ms));
      INSERT INTO forecast VALUES('open-meteo',0,3600000,100,0,100,1);
      INSERT INTO pv_forecast VALUES('zuid',0,3600000,'open-meteo',100,100,1);`);
    old.close();
    db = openDatabase(path);
    const repository = createRepository(db);
    assert.equal(repository.forecast(0, 3600000)[0].model, null);
    assert.equal(repository.pv(0, 3600000)[0].power_w, 100);
    repository.saveForecast(row(0, 15, 200, 2));
    db.close();
    db = openDatabase(path);
    assert.equal(createRepository(db).forecast(0, 3600000)[0].model, 'icon_d2');
    assert.equal(createRepository(db).forecast(0, 3600000)[1].model, null);
  } finally { db?.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('kwartierpieken bepalen het vroegste ESP32- en dagadvies terwijl verdere dagen uurwaarden gebruiken', () => {
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, pv: { calibration_factor: 1 }, location: { latitude: 52, longitude: 5 }, weather: { ...defaults.weather, forecast_days: 2 },
    advice: { ...defaults.advice, start_step_minutes: 15, search_hours: 2, reserve_w: 0, baseload_w: 0, min_solar_share: 1 } };
  const start = Date.parse('2026-10-16T10:00:00Z');
  const profile = { id: 'machine', name: 'Machine', duration_minutes: 15, steps: [{ duration_minutes: 15, power_w: 400 }] };
  const context = { settings, now: start, panels: panelsFixture(), panelErrors: [], latitude: 52, longitude: 5, baseload: { power_w: 0, source: 'config' } };
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  try {
    for (const item of normalizeOpenMeteo(payload(start), start).rows) repository.saveForecast(item);
    const tomorrow = start + 86400000;
    repository.saveForecast(row(tomorrow, 60, 500, start));
    repository.saveSun('2026-10-16', start, start + 60 * minute, 'test', start);
    repository.saveSun('2026-10-17', tomorrow, tomorrow + 60 * minute, 'test', start);
    const weather = repository.forecast(start, tomorrow + 60 * minute);
    const advice = advise(profile, weather, context);
    assert.equal(advice.can_start_now, false);
    assert.equal(advice.earliest_start, '2026-10-16T10:15:00.000Z');
    assert.equal(advice.earliest.solar_wh, 100);
    const daily = dailyAdvice([profile], weather, context, repository);
    assert.equal(daily.days[0].appliances[0].earliest_start, '2026-10-16T10:15:00.000Z');
    assert.equal(daily.days[1].appliances[0].earliest_start, '2026-10-17T10:00:00.000Z');
  } finally { db.close(); }
});

test('grafiek en cursor verbinden kwartieren met uurterugval en laten ontbrekende kwartieren open', () => {
  const start = Date.parse('2026-10-16T10:00:00Z');
  const slots = [row(start, 15, 200), row(start + 30 * minute, 15, 600), row(start + 45 * minute, 15, 400), row(start + 60 * minute, 60, 200)]
    .map((item) => ({ start: new Date(item.start_ms).toISOString(), end: new Date(item.end_ms).toISOString(), power_w: item.ghi }));
  const points = forecastLinePoints(slots, start, start + 120 * minute);
  assert.equal(lineValueAt(points, start + 22 * minute, 75 * minute), null);
  assert.equal(canConnectPoints(points[1], points[2], 75 * minute), false);
  assert.equal(lineValueAt(points, start + 45 * minute, 75 * minute), 600);
  assert.equal(lineValueAt(points, start + 60 * minute, 75 * minute), 400);
  assert.equal(points[0].ms, start);
  assert.equal(points.at(-1).ms, start + 120 * minute);
});

test('HTTP-endpoints tonen kwartiermodel, gemengde resoluties en behouden één quotumverzoek bij logging uit', async () => {
  const { settings: defaults } = loadConfiguration();
  const now = Date.now(), start = Math.floor(now / (60 * minute)) * 60 * minute;
  const day = localDay(now);
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, location: { latitude: 52, longitude: 5 }, pv: { calibration_factor: 1.78 } };
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  repository.saveSun(day, now - 6 * 60 * minute, now + 6 * 60 * minute, 'test', now);
  repository.setLogging('weather', false);
  let calls = 0;
  const weather = createWeatherScheduler({ settings, panels: panelsFixture(), panelErrors: [], repository, clock: () => now,
    source: async ({ resolutionMinutes }) => {
      calls++;
      assert.equal(resolutionMinutes, 15);
      return { ...normalizeOpenMeteo(payload(start), now), sun: [] };
    } });
  await weather.tick();
  await weather.tick();
  const server = startHttpServer({ settings, panels: panelsFixture(), panelErrors: [], repository, weather, homewizard: { status: () => ({ p1: null, kwh: null }) } });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await (await fetch(`${base}/intern/api/v1/forecast/day`)).json();
    assert.equal(result.status, 'ok');
    assert.equal(result.resolution_minutes, 15);
    assert.equal(result.mixed_resolution, true);
    assert.deepEqual(result.resolutions_minutes, [15, 60]);
    assert.equal(result.calibration_factor, 1.78);
    assert.ok(result.slots.some((slot) => slot.model === 'icon_d2' && slot.resolution_minutes === 15 && slot.power_w === 890));
    assert.ok(result.slots.some((slot) => slot.model === 'best_match' && slot.source_resolution_minutes === 60 && slot.power_w === 178));
    const irradiance = await (await fetch(`${base}/intern/api/v1/irradiance?hours=3`)).json();
    assert.ok(irradiance.slots.length);
    assert.ok(irradiance.slots.every((slot) => [15, 60].includes(slot.source_resolution_minutes)));
    const overview = await (await fetch(`${base}/intern/api/v1/weather`)).json();
    assert.deepEqual(overview.forecast.resolutions_minutes, [15, 60]);
    assert.equal(overview.status.preferred_resolution_minutes, 15);
    assert.equal(new URL(overview.request_url).searchParams.get('models'), 'best_match,icon_d2');
    assert.equal(overview.calls.rows.length, 0);
    assert.equal(overview.status.used_requests, 1);
    assert.equal(calls, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});
