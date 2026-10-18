import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { loadConfiguration } from '../src/config/load.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { offlineSunTimes } from '../src/weather/solar-position.js';
import { startHttpServer } from '../src/api/http-server.js';

test('weerpagina toont configuratie, verzendt handmatig verzoek en registreert HTTP-diagnose', async () => {
  const { settings: defaults, panels, panel_errors: panelErrors } = loadConfiguration();
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const day = '2026-10-14';
  const sun = offlineSunTimes(day, 52.2, 5.2);
  const now = (sun.sunrise_ms + sun.sunset_ms) / 2;
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, location: { latitude: 52.2, longitude: 5.2 }, weather: { ...defaults.weather, max_requests_per_local_day: 1 } };
  const weather = createWeatherScheduler({
    settings, panels, panelErrors, repository, clock: () => now,
    source: async () => ({ rows: [{ source: 'open-meteo', start_ms: sun.sunrise_ms, end_ms: sun.sunrise_ms + 3600000, ghi: 200, dni: 120, dhi: 80, fetched_ms: now }], sun: [{ day, ...sun }], request: { url: 'https://api.open-meteo.com/v1/forecast', http_status: 200, duration_ms: 20 } })
  });
  const server = startHttpServer({ settings, panels, panelErrors, repository, weather, homewizard: { status: () => ({ p1: null, kwh: null }) } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/intern/weather`)).text();
    assert.match(page, /Weerverzoeken/);
    assert.match(page, /weather\.js" type="module"/);
    assert.equal((await fetch(`${base}/intern/weather-chart.js`)).status, 200);
    const before = await (await fetch(`${base}/intern/api/v1/weather`)).json();
    assert.match(before.request_url, /latitude=52\.2/);
    assert.equal(before.status.used_requests, 0);
    const request = await fetch(`${base}/intern/api/v1/weather/refresh`, { method: 'POST' });
    assert.equal(request.status, 200);
    assert.equal((await request.json()).attempted, true);
    const after = await (await fetch(`${base}/intern/api/v1/weather?status=ok&limit=1`)).json();
    assert.equal(after.status.used_requests, 1);
    assert.equal(after.calls.rows[0].http_status, 200);
    assert.equal(after.calls.rows[0].forecast_rows, 1);
    assert.equal(after.forecast.rows[0].ghi_w_m2, 200);
    assert.equal((await (await fetch(`${base}/intern/api/v1/weather/diagnostics`, { method: 'DELETE' })).json()).calls_deleted, 1);
    const cleared = await (await fetch(`${base}/intern/api/v1/weather`)).json();
    assert.equal(cleared.status.used_requests, 1);
    assert.equal(cleared.calls.rows.length, 0);
    assert.equal(cleared.forecast.rows[0].ghi_w_m2, 200);
    assert.equal((await (await fetch(`${base}/intern/api/v1/weather/refresh`, { method: 'POST' })).json()).reason, 'quota');
    assert.equal((await fetch(`${base}/intern/api/v1/weather?status=unknown`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
