import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { startHttpServer } from '../src/api/http-server.js';
import { forecastDaysResponse } from '../src/api/forecast-days.js';
import { learnPvCorrection } from '../src/pv/learn-correction.js';
import { localDay } from '../src/weather/local-day.js';
import { clockQuarter } from '../src/pv/quarter.js';

test('API corrigeert op alle drie dagen hetzelfde Nederlandse klokkwartier met de eigen dagverwachting, ook rond wintertijd', async (context) => {
  let now = Date.parse('2026-10-24T10:00:00Z');
  context.mock.method(Date, 'now', () => now);
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, location: { latitude: 52, longitude: 5 },
    growatt: { ...defaults.growatt, expected_inverters: 1 } };
  const panels = { expected_panel_count: 5, inverters: [{ id: 'mic', serial: 'TEST123456', ac_limit_w: 2000 }],
    groups: [{ id: 'zuid', inverter_id: 'mic', count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 0.8 }] };
  const db = openDatabase(':memory:'), repository = createRepository(db);
  const dates = ['2026-10-24', '2026-10-25', '2026-10-26'];
  for (const [index, date] of dates.entries()) {
    const sunrise = Date.parse(`${date}T06:00:00Z`) + index * 60000;
    repository.saveSun(date, sunrise, sunrise + 10 * 3600000, 'test', now);
    for (let hour = 4; hour < 20; hour++) repository.saveForecast({ source: 'open-meteo', start_ms: Date.parse(`${date}T00:00:00Z`) + hour * 3600000,
      end_ms: Date.parse(`${date}T00:00:00Z`) + (hour + 1) * 3600000, ghi: 250 + index * 50, dni: 0, dhi: 250 + index * 50, fetched_ms: now });
  }
  const learned = learnPvCorrection(repository, settings, panels, [], [{ serial: 'TEST123456', measured_ms: now, received_ms: now, power_w: 200 }], now, { defer: false });
  assert.equal(learned.status, 'updated');
  assert.equal(learned.factor, 0.5);
  const attempt = repository.beginCall(dates[0], now, 'test');
  repository.finishCall(attempt, 'ok');
  const server = startHttpServer({ settings, panels, panelErrors: [], repository, homewizard: { status: () => ({}) }, weather: { status: () => {
    const sun = repository.getSun(localDay(now));
    return { sunrise: sun ? new Date(sun.sunrise_ms).toISOString() : null, sunset: sun ? new Date(sun.sunset_ms).toISOString() : null };
  } } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await (await fetch(`${base}/intern/api/v1/forecast/days`)).json();
    assert.deepEqual(result.days.map((day) => day.date), dates);
    assert.equal(result.generated_at, new Date(now).toISOString());
    for (const [index, day] of result.days.entries()) {
      assert.equal(day.status, 'ok');
      assert.equal(day.sunrise, new Date(repository.getSun(dates[index]).sunrise_ms).toISOString());
      assert.equal(day.sunset, new Date(repository.getSun(dates[index]).sunset_ms).toISOString());
      assert.ok(day.slots.length > 20);
      const future = day.slots.filter((slot) => Date.parse(slot.start) > now);
      for (const slot of future) {
        const factor = index > 0 && clockQuarter(Date.parse(slot.end)) === clockQuarter(now) ? 0.5 : 1;
        assert.equal(slot.base_power_w, 400 + index * 80);
        assert.equal(slot.power_w, (400 + index * 80) * factor);
        assert.equal(slot.automatic_correction_factor, factor);
      }
    }
    const corrected = result.days.flatMap((day) => day.slots).filter((slot) => slot.automatic_correction_factor !== 1);
    assert.equal(corrected.length, 3);
    assert.deepEqual(corrected.map((slot) => slot.power_w), [200, 240, 280]);
    assert.deepEqual(corrected.map((slot) => slot.end), ['2026-10-24T10:00:00.000Z', '2026-10-25T11:00:00.000Z', '2026-10-26T11:00:00.000Z']);
    assert.ok(corrected.every((slot) => slot.correction_reference_end === new Date(now).toISOString()));
    assert.deepEqual(await (await fetch(`${base}/intern/api/v1/forecast/day`)).json(), result.days[0]);
    assert.deepEqual(await (await fetch(`${base}/intern/api/v1/forecast/day?date=2026-10-26`)).json(), result.days[2]);
    for (const value of ['2026-02-30', '2026-13-01', '2026-1-01', 'morgen']) assert.equal((await fetch(`${base}/intern/api/v1/forecast/day?date=${value}`)).status, 400);
    assert.equal(repository.countCalls(dates[0]), 1);
    const page = await (await fetch(`${base}/dashboard`)).text();
    assert.match(page, /pv-chart-tomorrow/);
    assert.match(page, /pv-chart-after-tomorrow/);
    assert.equal((await fetch(`${base}/dashboard-production-days.js`)).status, 200);
    now = Date.parse('2026-10-24T22:30:00Z');
    const midnight = await (await fetch(`${base}/intern/api/v1/forecast/days`)).json();
    assert.deepEqual(midnight.days.map((day) => day.date), ['2026-10-25', '2026-10-26', '2026-10-27']);
    assert.equal(localDay(Date.parse(midnight.days[2].sunrise)), '2026-10-27');
    assert.equal(midnight.days[2].status, 'forecast_unavailable');
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});

test('drie daggrafieken krijgen expliciete lege grenzen als de locatie nog ontbreekt', () => {
  const { settings, panels, panel_errors: panelErrors } = loadConfiguration();
  const db = openDatabase(':memory:');
  try {
    const result = forecastDaysResponse(createRepository(db), settings, panels, panelErrors, {}, Date.parse('2026-10-16T23:00:00Z'));
    assert.deepEqual(result.days.map((day) => day.date), ['2026-10-17', '2026-10-18', '2026-10-19']);
    assert.ok(result.days.every((day) => day.status === 'sun_times_unavailable' && day.sunrise === null && day.sunset === null && day.slots.length === 0));
  } finally { db.close(); }
});
