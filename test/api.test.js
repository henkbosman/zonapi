import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { loadConfiguration } from '../src/config/load.js';
import { startHttpServer } from '../src/api/http-server.js';

test('API en dashboard geven ontbrekende configuratie expliciet terug', async () => {
  const { settings, panels, panel_errors: panelErrors } = loadConfiguration();
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const server = startHttpServer({ settings: { ...settings, http: { host: '127.0.0.1', port: 0 } }, panels, panelErrors, repository, weather: { status: () => ({ source: 'open-meteo', used_requests: 0, max_requests: 12, location_configured: false }) }, homewizard: { status: () => ({ p1: null, kwh: null }) } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const forecast = await (await fetch(`${base}/intern/api/v1/forecast?hours=3`)).json();
  assert.equal(forecast.status, 'forecast_unavailable');
  const advice = await (await fetch(`${base}/intern/api/v1/appliances/wasmachine/advice`)).json();
  assert.equal(advice.status, 'configuration_incomplete');
  assert.ok(advice.missing.some((item) => item.includes('wp_per_panel')));
  const meters = await (await fetch(`${base}/intern/api/v1/meters/current`)).json();
  assert.equal(meters.net_power_w, null);
  const daily = await (await fetch(`${base}/intern/api/v1/appliances/daily`)).json();
  assert.equal(daily.days.length, settings.weather.forecast_days);
  assert.equal(daily.days[0].appliances.length, 3);
  const dashboard = await fetch(`${base}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Zonopbrengst/);
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('daggrafiek toont alleen totalen en logs wissen bewaart ook losse omvormermetingen', async () => {
  const { settings, panels, panel_errors: panelErrors } = loadConfiguration();
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const now = Date.now();
  const measured = now - 60000;
  for (let index = 0; index < 3; index++) {
    const id = repository.saveFrame(measured, 'local', 6, `${50 + index}04`, 'decoded', Buffer.from([index]));
    repository.saveInverter({ serial: `INV123456${index}`, measured_ms: measured, received_ms: measured, power_w: (index + 1) * 100, energy_today_kwh: 2, energy_total_kwh: 200, frame_id: id });
  }
  repository.saveGrowattEvent(now, 'local', 'reply_sent', '5004 · 11 bytes');
  const sunrise = new Date(now - 6 * 3600000).toISOString();
  const sunset = new Date(now + 2 * 3600000).toISOString();
  const server = startHttpServer({
    settings: { ...settings, http: { host: '127.0.0.1', port: 0 } }, panels, panelErrors, repository,
    weather: { status: () => ({ source: 'open-meteo', sunrise, sunset, used_requests: 0, max_requests: 12, location_configured: true }) },
    homewizard: { status: () => ({ p1: null, kwh: null }) }
  });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const day = await (await fetch(`${base}/intern/api/v1/production/day`)).json();
    assert.equal(day.sunrise, sunrise);
    assert.equal(day.sunset, sunset);
    assert.deepEqual(day.points, []);
    assert.equal(day.overview_group_seconds, 60);
    const dashboard = await (await fetch(`${base}/dashboard`)).text();
    assert.match(dashboard, /dashboard\.js" type="module"/);
    assert.match(dashboard, /chart-coverage/);
    const chartModule = await fetch(`${base}/dashboard-production-chart.js`);
    assert.equal(chartModule.status, 200);
    assert.match(await chartModule.text(), /drawProductionChart/);
    assert.equal((await (await fetch(`${base}/intern/api/v1/status`)).json()).growatt.power_w, null);
    const cleared = await fetch(`${base}/intern/api/v1/growatt/diagnostics`, { method: 'DELETE' });
    assert.deepEqual(await cleared.json(), { frames_deleted: 3, events_deleted: 1, cloud_calls_deleted: 0 });
    assert.deepEqual((await (await fetch(`${base}/intern/api/v1/growatt/timeline`)).json()).rows, []);
    assert.deepEqual((await (await fetch(`${base}/intern/api/v1/production/day`)).json()).points, day.points);
    assert.equal(repository.history('inverter', measured - 1, now + 1, 100).length, 3);
    assert.equal((await (await fetch(`${base}/intern/api/v1/growatt`)).json()).summary.frames_total, 0);
    assert.equal((await fetch(`${base}/intern/api/v1/growatt/diagnostics`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('dagvoorspelling leest ochtend en middag uit de cache en laat het bestaande drie-uursendpoint intact', async () => {
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, location: { latitude: 52, longitude: 5 } };
  const panels = { inverters: [{ id: 'mic', ac_limit_w: 2000 }], groups: [{ id: 'zuid', inverter_id: 'mic', count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 0.8 }] };
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const now = Date.now();
  const sunrise = new Date(now - 6 * 3600000).toISOString(), sunset = new Date(now + 10 * 3600000).toISOString();
  for (let hour = -8; hour < 13; hour++) repository.saveForecast({ source: 'open-meteo', start_ms: now + hour * 3600000, end_ms: now + (hour + 1) * 3600000, ghi: 200, dni: 0, dhi: 200, fetched_ms: now });
  const server = startHttpServer({ settings, panels, panelErrors: [], repository, weather: { status: () => ({ sunrise, sunset }) }, homewizard: { status: () => ({ p1: null, kwh: null }) } });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const day = await (await fetch(`${base}/intern/api/v1/forecast/day`)).json();
    assert.equal(day.status, 'ok');
    assert.equal(day.sunrise, sunrise);
    assert.equal(day.sunset, sunset);
    assert.ok(day.slots.some((slot) => Date.parse(slot.start) < now - 4 * 3600000));
    assert.ok(day.slots.some((slot) => Date.parse(slot.start) > now + 8 * 3600000));
    assert.ok(day.slots.every((slot) => slot.power_w === 320));
    assert.equal(repository.lastCall(), null);
    const upcoming = await (await fetch(`${base}/intern/api/v1/forecast?hours=3`)).json();
    assert.ok(upcoming.slots.length > 0 && upcoming.slots.length <= 4);
    assert.ok(upcoming.slots.every((slot) => Date.parse(slot.end) > now && Date.parse(slot.start) < Date.parse(day.now) + 3 * 3600000 + 1000));
    assert.equal((await fetch(`${base}/production-chart-series.js`)).status, 200);
    const html = await (await fetch(`${base}/dashboard`)).text();
    assert.match(html, /Voorspelling · hele dag/);
    assert.doesNotMatch(html, /Voorspelling · 3 uur/);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});
