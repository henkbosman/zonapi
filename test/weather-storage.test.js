import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { normalizeOpenMeteo, forecastUrl, fetchOpenMeteo } from '../src/weather/open-meteo-client.js';
import { offlineSunTimes } from '../src/weather/solar-position.js';
import { localDay } from '../src/weather/local-day.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { createBackupJob } from '../src/storage/backup.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addCalendarDays, localDayRange } from '../src/weather/local-calendar.js';

test('drie uur terugblik en de toekomstige stappen volgen de bronklok en de Nederlandse kalender, inclusief middernacht en zomer-/wintertijd', () => {
  for (const text of ['2026-10-28T09:37:12Z', '2026-10-27T23:02:03Z', '2026-03-28T23:02:03Z', '2026-10-24T22:02:03Z', '2026-10-25T00:37:12Z', '2026-10-25T01:37:12Z']) {
    const now = Date.parse(text), hour = 3600000, quarter = 900000;
    for (const days of [3, 7]) {
      const url = forecastUrl(52, 5, days, 15, now), params = url.searchParams;
      const until = localDayRange(addCalendarDays(localDay(now), days - 1)).end_ms;
      assert.equal(params.get('models'), 'best_match'); assert.equal(params.get('forecast_days'), String(days));
      assert.equal(params.get('past_hours'), '3'); assert.equal(params.get('past_minutely_15'), '12');
      assert.equal(params.has('past_days'), false);
      assert.equal(Math.floor(now / hour) * hour + Number(params.get('forecast_hours')) * hour, until);
      assert.equal(Math.floor(now / quarter) * quarter + Number(params.get('forecast_minutely_15')) * quarter, until);
      const hourUrl = forecastUrl(52, 5, days, 60, now);
      assert.equal(hourUrl.searchParams.get('forecast_hours'), params.get('forecast_hours'));
      assert.equal(hourUrl.searchParams.get('minutely_15'), 'cloud_cover,weather_code'); assert.equal(hourUrl.searchParams.get('past_minutely_15'), '12');
    }
  }
  const summer = forecastUrl(52, 5, 3, 15, Date.parse('2026-03-28T23:00:00Z'));
  const winter = forecastUrl(52, 5, 3, 15, Date.parse('2026-10-24T22:00:00Z'));
  assert.equal(summer.searchParams.get('forecast_hours'), '71'); assert.equal(winter.searchParams.get('forecast_hours'), '73');
});

test('uurmodus gebruikt expliciet Best Match met drie uur terugblik en bewaart de exacte reden van een HTTP 400', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-28T09:37:12Z'));
  const url = forecastUrl(52.442903, 5.854103, 3, 60);
  assert.equal(url.searchParams.get('models'), 'best_match');
  assert.equal(url.searchParams.get('past_hours'), '3');
  assert.equal(url.searchParams.get('past_minutely_15'), '12');
  assert.equal(url.searchParams.get('minutely_15'), 'cloud_cover,weather_code');
  assert.equal(url.searchParams.get('hourly'), 'shortwave_radiation,direct_normal_irradiance,diffuse_radiation');
  assert.equal(url.searchParams.get('forecast_days'), '3');
  assert.equal(url.searchParams.has('past_days'), false);
  await assert.rejects(fetchOpenMeteo({ latitude: 52.442903, longitude: 5.854103, days: 3, resolutionMinutes: 60, fetcher: async (target) => {
    assert.equal(target.toString(), url.toString());
    return new Response(JSON.stringify({ error: true, reason: 'Invalid value for parameter models' }), { status: 400 });
  } }), (error) => {
    assert.match(error.message, /HTTP 400: Invalid value for parameter models/);
    assert.equal(error.http_status, 400);
    assert.equal(error.request_url, url.toString());
    return true;
  });
});

test('Open-Meteo geeft voorafgaand uur in UTC en recentere prognose overschrijft dat tijdvak', () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const t = Date.UTC(2026, 9, 25, 1) / 1000;
  const received = normalizeOpenMeteo({ hourly: { time: [t], shortwave_radiation: [400], direct_normal_irradiance: [300], diffuse_radiation: [100] }, daily: { sunrise: [], sunset: [] } }, 1000);
  assert.equal(received.rows[0].start_ms, (t - 3600) * 1000);
  repository.saveForecast(received.rows[0]);
  repository.saveForecast({ ...received.rows[0], ghi: 500, fetched_ms: 2000 });
  repository.saveForecast({ ...received.rows[0], ghi: 200, fetched_ms: 1500 });
  assert.equal(repository.forecast(0, t * 1000)[0].ghi, 500);
  assert.equal(localDay(Date.UTC(2026, 9, 25, 1)), '2026-10-25');
  db.close();
});

test('scheduler haalt ook na zonsondergang op en voorkomt dubbele verzoeken binnen één tijdvak', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const day = '2026-10-14';
  const sun = offlineSunTimes(day, 52.2, 5.2);
  let now = (sun.sunrise_ms + sun.sunset_ms) / 2;
  let calls = 0;
  const settings = { location: { latitude: 52.2, longitude: 5.2 }, weather: { source: 'open-meteo', poll_minutes: 720, forecast_days: 3, retry_minutes: 60 } };
  const source = async () => { calls++; return { rows: [{ source: 'open-meteo', start_ms: now, end_ms: now + 3600000, ghi: 200, dni: 150, dhi: 50, fetched_ms: now }], sun: [{ day, ...sun }] }; };
  const scheduler = createWeatherScheduler({ settings, panels: {}, panelErrors: ['wp ontbreekt'], repository, clock: () => now, source });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(repository.countCalls(day), 1);
  now += 12 * 3600000;
  await scheduler.tick();
  assert.equal(calls, 2);
  assert.equal(repository.getSun(day).sunrise_ms, sun.sunrise_ms);
  db.close();
});

test('handmatig weer ophalen bewaart fouten en successen zonder daglimiet', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const day = '2026-10-14';
  const sun = offlineSunTimes(day, 52.2, 5.2);
  let now = (sun.sunrise_ms + sun.sunset_ms) / 2;
  let attempts = 0;
  const settings = { location: { latitude: 52.2, longitude: 5.2 }, weather: { source: 'open-meteo', poll_minutes: 720, forecast_days: 3, retry_minutes: 60 } };
  const source = async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('Open-Meteo HTTP 400: invalid model'), { http_status: 400, duration_ms: 11, request_url: 'https://api.open-meteo.com/v1/forecast' });
    return { rows: [{ source: 'open-meteo', start_ms: now, end_ms: now + 3600000, ghi: 200, dni: 150, dhi: 50, fetched_ms: now }], sun: [{ day, ...sun }], request: { url: 'https://api.open-meteo.com/v1/forecast', http_status: 200, duration_ms: 9 } };
  };
  const scheduler = createWeatherScheduler({ settings, panels: {}, panelErrors: ['wp ontbreekt'], repository, clock: () => now, source });
  assert.equal((await scheduler.refresh()).reason, 'error');
  assert.equal(repository.recentWeatherCalls('error', 10, 0).rows[0].http_status, 400);
  assert.match(scheduler.status().last_error, /invalid model/);
  assert.equal((await scheduler.refresh()).reason, 'ok');
  assert.equal(repository.lastSuccessfulWeatherCall().forecast_rows, 1);
  assert.equal(repository.countCalls(day), 2);
  assert.equal(scheduler.status().last_error, null);
  assert.equal((await scheduler.refresh()).reason, 'ok');
  assert.equal(attempts, 3);
  now = sun.sunset_ms + 1000;
  assert.equal((await scheduler.refresh()).reason, 'ok');
  assert.equal(attempts, 4);
  db.close();
});

test('bestaande weerpogingen blijven leesbaar na toevoeging van diagnosekolommen', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-weather-'));
  const path = join(folder, 'old.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE weather_calls (id INTEGER PRIMARY KEY, local_date TEXT NOT NULL, attempted_ms INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT); INSERT INTO weather_calls(local_date,attempted_ms,status,detail) VALUES('2026-10-14',123,'error','oude fout')");
  legacy.close();
  const db = openDatabase(path);
  const repository = createRepository(db);
  assert.equal(repository.lastCall().detail, 'oude fout');
  assert.equal(repository.lastCall().http_status, null);
  repository.beginCall('2026-10-14', 124, 'open-meteo');
  assert.equal(repository.countCalls('2026-10-14'), 2);
  db.close(); rmSync(folder, { recursive: true, force: true });
});

test('dagelijkse back-up bevat ook latere metingen, zonder WAL-kopie', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-backup-'));
  const db = openDatabase(join(folder, 'live.sqlite'));
  const repository = createRepository(db);
  const job = createBackupJob(db, folder);
  repository.beginCall('2026-10-14', 100);
  const path = await job.run();
  repository.beginCall('2026-10-14', 200);
  assert.equal(await job.run(), path);
  const copy = openDatabase(path);
  assert.equal(createRepository(copy).countCalls('2026-10-14'), 2);
  assert.ok(readFileSync(path).length > 0);
  copy.close(); db.close(); rmSync(folder, { recursive: true, force: true });
});
