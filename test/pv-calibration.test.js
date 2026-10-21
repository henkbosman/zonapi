import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfiguration, validateSettings } from '../src/config/load.js';
import { getCalibrationFactor } from '../src/pv/calibration.js';
import { estimatePv } from '../src/pv/model.js';
import { refreshPvForecast } from '../src/pv/refresh-forecast.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { startHttpServer } from '../src/api/http-server.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { offlineSunTimes } from '../src/weather/solar-position.js';
import { advise } from '../src/appliances/start-advice.js';
import { dailyAdvice } from '../src/appliances/daily-advice.js';

/** Bouwt een paneelconfiguratie die bij 130 W/m² precies 208 W geeft; input: geen; output: paneelconfiguratie. */
function panelsFixture() {
  return { expected_panel_count: 5, inverters: [{ id: 'mic', serial: '', ac_limit_w: 2000 }],
    groups: [{ id: 'zuid', inverter_id: 'mic', count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 0.8 }] };
}

/** Maakt één gelijkmatig instralingsuur; input: begintijd en optionele ophaaltijd in ms; output: weerrij. */
function weatherRow(start, fetched = start) {
  return { source: 'open-meteo', start_ms: start, end_ms: start + 3600000, ghi: 130, dni: 0, dhi: 130, fetched_ms: fetched };
}

test('kalibratie is optioneel, valideert getallen en laat bestaande instellingen op factor één werken', () => {
  const { settings } = loadConfiguration();
  const { pv, ...legacy } = settings;
  assert.equal(getCalibrationFactor(legacy), 1);
  assert.deepEqual(validateSettings(legacy), []);
  for (const factor of [0.1, 0.5, 1, 1.78, 10]) {
    const config = { ...legacy, pv: { calibration_factor: factor } };
    assert.equal(getCalibrationFactor(config), factor);
    assert.deepEqual(validateSettings(config), []);
  }
  for (const factor of [null, false, '1.78', 0, -1, 10.01, NaN, Infinity]) {
    const config = { ...legacy, pv: { calibration_factor: factor } };
    assert.throws(() => getCalibrationFactor(config), /pv.calibration_factor/);
    assert.ok(validateSettings(config).some((error) => error.includes('pv.calibration_factor')));
  }
  for (const invalid of [null, '1.78', []]) assert.ok(validateSettings({ ...legacy, pv: invalid }).some((error) => error.startsWith('pv ')));
});

test('kalibratie verhoogt of verlaagt PV-opbrengst en begrenst nog steeds iedere omvormer afzonderlijk', () => {
  const row = weatherRow(Date.parse('2026-10-16T10:00:00Z'));
  const panels = panelsFixture();
  assert.equal(estimatePv(row, panels, 52, 5).power_w, 208);
  assert.equal(estimatePv(row, panels, 52, 5, 1.78).power_w, 370.2);
  assert.equal(estimatePv(row, panels, 52, 5, 0.5).power_w, 104);
  const multiple = { inverters: [{ id: 'a', ac_limit_w: 2000 }, { id: 'b', ac_limit_w: 2000 }],
    groups: [{ ...panels.groups[0], id: 'a', inverter_id: 'a', count: 20 }, { ...panels.groups[0], id: 'b', inverter_id: 'b', count: 1 }] };
  const clipped = estimatePv({ ...row, ghi: 2000, dhi: 2000 }, multiple, 52, 5, 1.78);
  assert.equal(clipped.groups[0].power_w, 2000);
  assert.equal(clipped.groups[1].power_w, 1139.2);
  assert.equal(clipped.power_w, 3139.2);
});

test('daggrafiek en drie-uurs-API gebruiken dezelfde factor terwijl instraling en echte metingen behouden blijven', async () => {
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, location: { latitude: 52, longitude: 5 }, pv: { calibration_factor: 1.78 } };
  const now = Date.now(), from = Math.floor(now / 3600000) * 3600000;
  const sunrise = new Date(now - 6 * 3600000).toISOString(), sunset = new Date(now + 10 * 3600000).toISOString();
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  for (let hour = -7; hour < 12; hour++) repository.saveForecast(weatherRow(from + hour * 3600000, now));
  repository.saveInverter({ serial: 'TEST123456', measured_ms: now, received_ms: now, power_w: 370, energy_today_kwh: 1, energy_total_kwh: 10, frame_id: null });
  const server = startHttpServer({ settings, panels: panelsFixture(), panelErrors: [], repository,
    weather: { status: () => ({ sunrise, sunset }) }, homewizard: { status: () => ({ p1: null, kwh: null }) } });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/intern/api/v1/forecast?hours=3', '/intern/api/v1/forecast/day']) {
      const response = await (await fetch(base + path)).json();
      assert.equal(response.status, 'ok');
      assert.equal(response.calibration_factor, 1.78);
      assert.ok(response.slots.length > 0);
      assert.ok(response.slots.every((slot) => slot.power_w === 370.2 && slot.ghi_w_m2 === 130));
    }
    const irradiation = await (await fetch(`${base}/intern/api/v1/irradiance?hours=3`)).json();
    assert.ok(irradiation.slots.every((slot) => slot.ghi_w_m2 === 130 && slot.groups[0].gti_w_m2 === 130));
    assert.equal(repository.currentInverters()[0].power_w, 370);
    assert.equal(repository.lastCall(), null);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});

test('een kalibratie verandert zowel het ESP32-advies als het startadvies per dag', () => {
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, pv: { calibration_factor: 1 }, weather: { ...defaults.weather, forecast_days: 2 },
    advice: { ...defaults.advice, reserve_w: 0, baseload_w: 0, min_solar_share: 1 } };
  const now = Date.parse('2026-10-16T10:00:00Z');
  const profile = { id: 'wasmachine', name: 'Wasmachine', duration_minutes: 60, steps: [{ duration_minutes: 60, power_w: 300 }] };
  const weather = [];
  for (let at = Date.parse('2026-10-16T06:00:00Z'); at < Date.parse('2026-10-17T19:00:00Z'); at += 3600000) weather.push(weatherRow(at, now));
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  try {
    for (const day of ['2026-10-16', '2026-10-17']) repository.saveSun(day, Date.parse(`${day}T06:00:00Z`), Date.parse(`${day}T18:00:00Z`), 'test', now);
    const context = { settings, now, panels: panelsFixture(), panelErrors: [], latitude: 52, longitude: 5, baseload: { power_w: 0, source: 'config' } };
    const low = advise(profile, weather, context);
    assert.equal(low.status, 'ok');
    assert.equal(low.can_start_now, false);
    assert.equal(low.earliest_start, null);
    assert.ok(dailyAdvice([profile], weather, context, repository).days.every((day) => day.appliances[0].earliest_start === null));
    const calibrated = { ...context, settings: { ...settings, pv: { calibration_factor: 1.78 } } };
    assert.equal(advise(profile, weather, calibrated).can_start_now, true);
    const daily = dailyAdvice([profile], weather, calibrated, repository);
    assert.equal(daily.days[0].appliances[0].can_start_now, true);
    assert.equal(daily.days[1].appliances[0].earliest_start, '2026-10-17T06:00:00.000Z');
  } finally { db.close(); }
});

test('ophalen en herstart-herberekening bewaren gekalibreerde PV met dezelfde brondata en weeropvraagteller', async () => {
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, location: { latitude: 52, longitude: 5 }, pv: { calibration_factor: 1 } };
  const now = Date.parse('2026-10-16T10:00:00Z');
  const sun = offlineSunTimes('2026-10-16', 52, 5);
  const rows = [-2, 0, 1].map((hour) => weatherRow(now + hour * 3600000, now));
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  let requests = 0;
  try {
    const weather = createWeatherScheduler({ settings, panels: panelsFixture(), panelErrors: [], repository, clock: () => now,
      source: async () => { requests++; return { rows, sun: [{ day: '2026-10-16', ...sun }] }; } });
    await weather.refresh();
    assert.ok(repository.pv(now - 3 * 3600000, now + 3 * 3600000).every((row) => row.power_w === 208));
    const calibrated = { ...settings, pv: { calibration_factor: 1.78 } };
    assert.equal(refreshPvForecast(repository, calibrated, panelsFixture(), [], now), 2);
    assert.ok(repository.pv(now, now + 3 * 3600000).every((row) => row.power_w === 370.2 && row.fetched_ms === now));
    assert.equal(repository.pv(now - 2 * 3600000, now - 3600000)[0].power_w, 208);
    assert.deepEqual(repository.forecast(now - 3 * 3600000, now + 3 * 3600000).map((row) => row.ghi), [130, 130, 130]);
    repository.savePv({ ...rows[1], group_id: 'zuid', power_w: 1, gti_w_m2: 130, fetched_ms: now - 1 });
    assert.equal(repository.pv(now, now + 3600000)[0].power_w, 370.2);
    assert.equal(requests, 1);
    assert.equal(repository.countCalls('2026-10-16'), 1);
    const next = createWeatherScheduler({ settings: calibrated, panels: panelsFixture(), panelErrors: [], repository, clock: () => now + 7200000,
      source: async () => { requests++; return { rows: rows.map((row) => ({ ...row, fetched_ms: now + 7200000 })), sun: [{ day: '2026-10-16', ...sun }] }; } });
    await next.refresh();
    assert.equal(requests, 2);
    assert.ok(repository.pv(now, now + 3 * 3600000).every((row) => row.power_w === 370.2));
  } finally { db.close(); }
});
