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
  const forecast = await (await fetch(`${base}/api/v1/forecast?hours=3`)).json();
  assert.equal(forecast.status, 'forecast_unavailable');
  const advice = await (await fetch(`${base}/api/v1/appliances/wasmachine/advice`)).json();
  assert.equal(advice.status, 'configuration_incomplete');
  assert.ok(advice.missing.some((item) => item.includes('wp_per_panel')));
  const meters = await (await fetch(`${base}/api/v1/meters/current`)).json();
  assert.equal(meters.net_power_w, null);
  const dashboard = await fetch(`${base}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Zonopbrengst/);
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('daggrafiek toont drie omvormers en logs wissen bewaart hun metingen', async () => {
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
    const day = await (await fetch(`${base}/api/v1/production/day`)).json();
    assert.equal(day.sunrise, sunrise);
    assert.equal(day.sunset, sunset);
    assert.deepEqual(day.points.map((point) => [point.power_w, point.active_inverters]), [[600, 3]]);
    const dashboard = await (await fetch(`${base}/dashboard`)).text();
    assert.match(dashboard, /dashboard\.js" type="module"/);
    assert.match(dashboard, /chart-coverage/);
    const chartModule = await fetch(`${base}/dashboard-production-chart.js`);
    assert.equal(chartModule.status, 200);
    assert.match(await chartModule.text(), /drawProductionChart/);
    assert.equal((await (await fetch(`${base}/api/v1/status`)).json()).growatt.power_w, null);
    const cleared = await fetch(`${base}/api/v1/growatt/diagnostics`, { method: 'DELETE' });
    assert.deepEqual(await cleared.json(), { frames_deleted: 3, events_deleted: 1 });
    assert.deepEqual((await (await fetch(`${base}/api/v1/growatt/timeline`)).json()).rows, []);
    assert.deepEqual((await (await fetch(`${base}/api/v1/production/day`)).json()).points, day.points);
    assert.equal((await (await fetch(`${base}/api/v1/growatt`)).json()).summary.frames_total, 0);
    assert.equal((await fetch(`${base}/api/v1/growatt/diagnostics`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
