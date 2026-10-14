import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { normalizeOpenMeteo } from '../src/weather/open-meteo-client.js';
import { offlineSunTimes } from '../src/weather/solar-position.js';
import { localDay } from '../src/weather/local-day.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { createBackupJob } from '../src/storage/backup.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('scheduler gebruikt daglicht, één verzoek per tijdvak en persistente quota', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const day = '2026-10-14';
  const sun = offlineSunTimes(day, 52.2, 5.2);
  let now = (sun.sunrise_ms + sun.sunset_ms) / 2;
  let calls = 0;
  const settings = { location: { latitude: 52.2, longitude: 5.2 }, weather: { source: 'open-meteo', max_requests_per_local_day: 2, forecast_days: 3, retry_minutes: 60 } };
  const source = async () => { calls++; return { rows: [{ source: 'open-meteo', start_ms: now, end_ms: now + 3600000, ghi: 200, dni: 150, dhi: 50, fetched_ms: now }], sun: [{ day, ...sun }] }; };
  const scheduler = createWeatherScheduler({ settings, panels: {}, panelErrors: ['wp ontbreekt'], repository, clock: () => now, source });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(repository.countCalls(day), 1);
  now += 12 * 3600000;
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(repository.getSun(day).sunrise_ms, sun.sunrise_ms);
  db.close();
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
