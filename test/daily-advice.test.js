import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { dailyAdvice } from '../src/appliances/daily-advice.js';
import { localDay } from '../src/weather/local-day.js';

test('dagadviezen zoeken voorbij 24 uur, respecteren zonuren en onderscheiden weinig zon van ontbrekende data rond wintertijd', () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  try {
    const now = Date.parse('2026-10-24T08:02:00Z');
    const settings = { weather: { forecast_days: 3, stale_after_hours: 4 }, advice: { search_hours: 24, start_step_minutes: 5, min_solar_share: 0.9, reserve_w: 0 } };
    const panels = { inverters: [{ id: 'mic', ac_limit_w: 2000 }], groups: [{ id: 'zuid', inverter_id: 'mic', count: 20, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 0.8 }] };
    for (const day of ['24', '25', '26']) repository.saveSun(`2026-10-${day}`, Date.parse(`2026-10-${day}T07:00:00Z`), Date.parse(`2026-10-${day}T16:00:00Z`), 'test', now);
    const weather = [];
    for (let at = Date.parse('2026-10-24T07:00:00Z'); at < Date.parse('2026-10-27T00:00:00Z'); at += 3600000) {
      if (localDay(at) === '2026-10-26') continue;
      const sunny = localDay(at) === '2026-10-25';
      weather.push({ start_ms: at, end_ms: at + 3600000, ghi: sunny ? 900 : 0, dni: 0, dhi: sunny ? 900 : 0, fetched_ms: now });
    }
    const profile = { id: 'wasmachine', name: 'Wasmachine', duration_minutes: 90, steps: [{ duration_minutes: 90, power_w: 500 }] };
    const context = { now, settings, panels, panelErrors: [], latitude: 52, longitude: 5, baseload: { power_w: 100 } };
    const result = dailyAdvice([profile], weather, context, repository);
    assert.deepEqual(result.days.map((day) => day.date), ['2026-10-24', '2026-10-25', '2026-10-26']);
    assert.equal(result.days[0].appliances[0].status, 'ok');
    assert.equal(result.days[0].appliances[0].earliest_start, null);
    const next = result.days[1].appliances[0];
    assert.equal(next.status, 'ok');
    assert.ok(Date.parse(next.earliest_start) >= Date.parse(result.days[1].sunrise));
    assert.ok(Date.parse(next.earliest_start) + 90 * 60000 <= Date.parse(result.days[1].sunset));
    assert.equal(next.can_start_now, null);
    assert.equal(result.days[2].appliances[0].status, 'forecast_incomplete');
    const partial = weather.filter((row) => row.start_ms !== Date.parse('2026-10-24T12:00:00Z'));
    assert.equal(dailyAdvice([profile], partial, context, repository).days[0].appliances[0].status, 'forecast_incomplete');
    const afterSunset = dailyAdvice([profile], weather, { ...context, now: Date.parse('2026-10-24T18:00:00Z') }, repository);
    assert.equal(afterSunset.days[0].appliances[0].status, 'no_daylight_window');
    const tooLong = { ...profile, duration_minutes: 600, steps: [{ duration_minutes: 600, power_w: 500 }] };
    assert.equal(dailyAdvice([tooLong], weather, context, repository).days[1].appliances[0].status, 'no_daylight_window');
    assert.ok(weather.length > 0);
    const stale = dailyAdvice([profile], weather.map((row) => ({ ...row, fetched_ms: now - 5 * 3600000 })), context, repository);
    assert.equal(stale.days[1].appliances[0].status, 'stale');
  } finally { db.close(); }
});
