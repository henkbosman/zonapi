import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { addCalendarDays, localDayRange } from '../src/weather/local-calendar.js';
import { localDay } from '../src/weather/local-day.js';

/** Maakt een weerscheduler zonder netwerk of paneelberekening; input: opslag, klok, bron en optionele weersettings; output: scheduler. */
function scheduler(repository, clock, source, weather = {}) {
  return createWeatherScheduler({ settings: { location: { latitude: 52, longitude: 5 }, weather: { source: 'open-meteo', forecast_days: 3, retry_minutes: 60, max_requests_per_local_day: 12, ...weather } },
    panels: {}, panelErrors: ['test'], repository, clock, source });
}

test('lokale kalendergrenzen blijven correct rond zomer- en wintertijd', () => {
  assert.deepEqual(localDayRange('2026-10-25'), { start_ms: Date.parse('2026-10-24T22:00:00Z'), end_ms: Date.parse('2026-10-25T23:00:00Z') });
  assert.deepEqual(localDayRange('2026-03-29'), { start_ms: Date.parse('2026-03-28T23:00:00Z'), end_ms: Date.parse('2026-03-29T22:00:00Z') });
  assert.equal(addCalendarDays('2026-10-24', 2), '2026-10-26');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  for (const invalid of ['2026-02-30', '2026-13-01', '2026-1-01', 'morgen']) assert.throws(() => addCalendarDays(invalid), /geldige datum/);
});

test('weerupdates lopen de hele nacht door; quota en tijdsinterval blijven gelden na herstart en logs wissen', async () => {
  const db = openDatabase(':memory:'), repository = createRepository(db);
  repository.setLogging('weather', false);
  let now = Date.parse('2026-10-16T20:00:00Z'), calls = 0;
  const source = async (options) => {
    calls++;
    assert.equal(options.days, 3);
    return { rows: [{ source: 'open-meteo', start_ms: now, end_ms: now + 3600000, ghi: 0, dni: 0, dhi: 0, fetched_ms: now }], sun: [] };
  };
  try {
    const weather = scheduler(repository, () => now, source, { forecast_days: 2 });
    assert.equal((await weather.tick()).reason, 'ok');
    assert.equal(calls, 1);
    assert.equal(repository.countCalls('2026-10-16'), 1);
    assert.equal(weather.status().next_fetch, '2026-10-16T22:00:00.000Z');
    assert.equal((await weather.tick()).reason, 'interval');
    repository.clearWeatherDiagnostics();
    const restarted = scheduler(repository, () => now, source);
    assert.equal(restarted.status().next_fetch, weather.status().next_fetch);
    assert.equal((await restarted.tick()).reason, 'interval');
    now += 2 * 3600000;
    assert.equal((await restarted.tick()).reason, 'ok');
    assert.equal(localDay(now), '2026-10-17');
    assert.equal(repository.countCalls('2026-10-17'), 1);
    now += 2 * 3600000;
    assert.equal((await restarted.tick()).reason, 'ok');
    assert.equal(calls, 3);
    assert.equal(repository.recentWeatherCalls('all', 10, 0).rows.length, 0);
    assert.equal(repository.forecast(Date.parse('2026-10-16T19:00:00Z'), now + 3600000).length, 3);
  } finally { db.close(); }
});

test('de volledige daglimiet verdeelt verzoeken over 23, 24 en 25 uur en stopt ook handmatige extra verzoeken', async () => {
  for (const day of ['2026-03-29', '2026-10-16', '2026-10-25']) {
    const db = openDatabase(':memory:'), repository = createRepository(db), range = localDayRange(day);
    let now = range.start_ms, calls = 0;
    const max = 12, spacing = (range.end_ms - range.start_ms) / max;
    const weather = scheduler(repository, () => now, async () => { calls++; return { rows: [], sun: [] }; });
    try {
      for (let index = 0; index < max; index++) {
        now = range.start_ms + index * spacing;
        assert.equal((await weather.tick()).reason, 'ok');
        assert.equal(calls, index + 1);
        assert.equal((await weather.tick()).attempted, false);
      }
      now = range.end_ms - 1;
      assert.equal((await weather.refresh()).reason, 'quota');
      assert.equal(calls, max);
      assert.equal(repository.countCalls(day), max);
      assert.equal(Date.parse(weather.status().next_fetch), range.end_ms);
      now = range.end_ms;
      const expectedNext = Math.max(now, range.start_ms + (max - 1) * spacing + (localDayRange(localDay(now)).end_ms - now) / max);
      if (expectedNext > now) now = expectedNext;
      assert.equal((await weather.tick()).reason, 'ok');
      assert.equal(calls, max + 1);
      assert.equal(repository.countCalls(addCalendarDays(day, 1)), 1);
    } finally { db.close(); }
  }
});

test('nachtelijke fouten respecteren retry_minutes; een lopende aanvraag krijgt geen tweede verzoek', async () => {
  const db = openDatabase(':memory:'), repository = createRepository(db);
  let now = Date.parse('2026-10-16T00:00:00Z'), calls = 0;
  const failed = scheduler(repository, () => now, async () => { calls++; throw new Error('testfout'); }, { max_requests_per_local_day: 48, retry_minutes: 90 });
  try {
    assert.equal((await failed.tick()).reason, 'error');
    assert.equal(Date.parse(failed.status().next_fetch), now + 90 * 60000);
    now += 30 * 60000;
    assert.equal((await failed.tick()).reason, 'interval');
    assert.equal(calls, 1);
    now += 60 * 60000;
    let finish;
    const pending = scheduler(repository, () => now, () => new Promise((resolve) => { finish = resolve; }), { max_requests_per_local_day: 48, retry_minutes: 90 });
    const run = pending.tick();
    assert.equal((await pending.tick()).reason, 'busy');
    finish({ rows: [], sun: [] });
    assert.equal((await run).reason, 'ok');
    const paused = scheduler(repository, () => now, async () => { throw new Error('onverwacht'); }, { max_requests_per_local_day: 0 });
    assert.equal((await paused.refresh()).reason, 'paused');
    assert.equal(paused.status().next_fetch, null);
  } finally { db.close(); }
});
