import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { loadConfiguration } from '../src/config/load.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { offlineSunTimes } from '../src/weather/solar-position.js';
import { startHttpServer } from '../src/api/http-server.js';
import { fetchOpenMeteo } from '../src/weather/open-meteo-client.js';
import { weatherLocationKey } from '../src/weather/clear-sky.js';

test('weerpagina toont configuratie, verzendt handmatig verzoek en registreert HTTP-diagnose', async () => {
  const { settings: defaults, panels, panel_errors: panelErrors } = loadConfiguration();
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const day = '2026-10-14';
  const sun = offlineSunTimes(day, 52.2, 5.2);
  const now = (sun.sunrise_ms + sun.sunset_ms) / 2;
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, location: { latitude: 52.2, longitude: 5.2 }, weather: { ...defaults.weather, poll_minutes: 15 } };
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
    assert.equal(before.status.poll_minutes, 15);
    assert.ok(!Object.hasOwn(before.status, 'max_requests'));
    assert.match(page, /id="poll-minutes"/);
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
    assert.equal((await (await fetch(`${base}/intern/api/v1/weather/refresh`, { method: 'POST' })).json()).reason, 'ok');
    assert.equal((await (await fetch(`${base}/intern/api/v1/weather`)).json()).status.used_requests, 2);
    assert.equal((await fetch(`${base}/intern/api/v1/weather?status=unknown`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('compacte aanvraag is gelijk aan de getoonde en gelogde URL en houdt drie daggrafieken en lokale historie beschikbaar', async (t) => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const { settings: defaults, panels, panel_errors: panelErrors } = loadConfiguration();
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, location: { latitude: 52.2, longitude: 5.2 } };
  const db = openDatabase(':memory:'), repository = createRepository(db);
  const start = now - 3 * 3600000; // Drie uur terug vanaf het huidige uur.
  const times = Array.from({ length: 61 }, (_, index) => start / 1000 + index * 3600);
  const quarters = Array.from({ length: 244 }, (_, index) => start / 1000 + index * 900);
  const days = ['2026-10-20', '2026-10-21', '2026-10-22'];
  const payload = { hourly: { time: times, shortwave_radiation_best_match: times.map(() => 200),
    direct_normal_irradiance_best_match: times.map(() => 0), diffuse_radiation_best_match: times.map(() => 200),
    cloud_cover_best_match: times.map(() => 0), weather_code_best_match: times.map(() => 0),
    cloud_cover_icon_d2: times.map(() => 0), weather_code_icon_d2: times.map(() => 0) },
    minutely_15: { time: quarters, shortwave_radiation_best_match: quarters.map(() => 250),
      direct_normal_irradiance_best_match: quarters.map(() => 0), diffuse_radiation_best_match: quarters.map(() => 250) },
    daily: { sunrise_best_match: days.map((day) => Date.parse(`${day}T06:00:00Z`) / 1000),
      sunset_best_match: days.map((day) => Date.parse(`${day}T16:00:00Z`) / 1000) } };
  const previous = { source: 'open-meteo', model: 'best_match', time_ms: start - 3600000,
    cloud_cover: 0, weather_code: 0, fetched_ms: now - 86400000 };
  repository.saveWeatherCondition(weatherLocationKey(settings.location), previous);
  let sentUrl = null, requests = 0;
  const weather = createWeatherScheduler({ settings, panels, panelErrors, repository, clock: () => now,
    source: (options) => fetchOpenMeteo({ ...options, fetcher: async (url) => {
      requests++;
      sentUrl = url.toString();
      assert.equal(url.searchParams.get('forecast_days'), '3');
      assert.equal(url.searchParams.has('past_days'), false);
      assert.equal(url.searchParams.get('models'), 'best_match');
      assert.equal(url.searchParams.get('past_hours'), '3'); assert.equal(url.searchParams.get('past_minutely_15'), '12');
      assert.equal(url.searchParams.get('forecast_hours'), '58'); assert.equal(url.searchParams.get('forecast_minutely_15'), '232');
      return Response.json(payload);
    } }) });
  const server = startHttpServer({ settings, panels, panelErrors, repository, weather, homewizard: { status: () => ({ p1: null, kwh: null }) } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  try {
    const before = await get('/intern/api/v1/weather');
    assert.equal((await weather.tick()).attempted, true);
    const after = await get('/intern/api/v1/weather');
    assert.equal(requests, 1);
    assert.equal(before.request_url, sentUrl);
    assert.equal(after.request_url, sentUrl);
    assert.equal(after.calls.rows[0].request_url, sentUrl);
    const forecast = await get('/intern/api/v1/forecast/days');
    assert.deepEqual(forecast.days.map((day) => day.date), days);
    assert.ok(forecast.days.every((day) => day.slots.length && day.conditions.rows.length));
    assert.ok(forecast.days[0].slots.some((slot) => Date.parse(slot.end) < now && slot.model === 'best_match'));
    assert.ok(forecast.days[2].slots.every((slot) => slot.model === 'best_match'));
    assert.equal(repository.weatherConditions(weatherLocationKey(settings.location), previous.time_ms, previous.time_ms).length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});
