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
