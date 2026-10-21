import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDebugConfiguration, defaultDebugConfiguration, normalizeDebugConfiguration } from '../src/config/debug.js';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { startHttpServer } from '../src/api/http-server.js';

test('debug.json wordt aangemaakt met logs uit en valideert booleans en bewaarlimieten', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-debug-')), path = join(folder, 'debug.json');
  try {
    const debug = createDebugConfiguration(path);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), defaultDebugConfiguration());
    assert.deepEqual(debug.readLogging(), { ...defaultDebugConfiguration().logging, error: null });
    for (const value of [null, [], { logging: null }, { logging: [] }, { logging: { growatt: 'false' } }, { logging: { weather: 1 } }, { logging: { homewizard: null } }, { logging: { max_entries_per_source: 99 } }]) {
      assert.throws(() => normalizeDebugConfiguration(value), /debug.json/);
    }
    writeFileSync(path, JSON.stringify({ logging: { growatt: true }, custom: { keep: true } }));
    assert.equal(debug.readLogging().growatt, true);
    debug.setLogging('weather', true);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(stored.logging.growatt, true);
    assert.equal(stored.logging.weather, true);
    assert.equal(stored.logging.homewizard, false);
    assert.deepEqual(stored.custom, { keep: true });
    assert.deepEqual(readdirSync(folder), ['debug.json']);
    writeFileSync(path, '{');
    assert.equal(debug.readLogging().growatt, false);
    assert.match(debug.readLogging().error, /debug.json/);
    assert.throws(() => createDebugConfiguration(path));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('debug.json bepaalt logopslag ook bij bestaande database-instellingen; metingen, status en weeropvraagteller blijven bestaan', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-debug-storage-')), path = join(folder, 'debug.json');
  const db = openDatabase(':memory:');
  try {
    const legacy = createRepository(db);
    for (const source of ['growatt', 'weather', 'homewizard']) legacy.setLogging(source, true);
    const debug = createDebugConfiguration(path), repository = createRepository(db, debug);
    const at = Date.parse('2026-10-16T23:00:00Z');
    assert.equal(repository.saveFrame(at, 'local', 6, '5004', 'decoded', Buffer.alloc(16)), null);
    repository.saveGrowattEvent(at, 'local', 'reply_sent', 'ACK');
    repository.saveInverter({ serial: 'TEST123456', measured_ms: at, received_ms: at, power_w: 250, energy_today_kwh: 1, energy_total_kwh: 10, frame_id: null });
    repository.saveCloudInverter({ serial: 'TEST123456', measured_ms: at, received_ms: at, power_w: 250, energy_today_kwh: 1, energy_total_kwh: 10 });
    repository.saveGrowattCloudCall({ attempted_ms: at, status: 'ok', http_status: 200, duration_ms: 20, request_url: 'https://openapi.growatt.com', detail: null });
    repository.saveHomeWizardCall({ attempted_ms: at, device: 'p1', status: 'ok', request_url: 'http://meter.local/api/v1/data', duration_ms: 10 });
    const attempt = repository.beginCall('2026-10-17', at, 'open-meteo');
    repository.finishCall(attempt, 'ok', { forecast_rows: 12 });
    assert.equal(attempt.id, null);
    for (const table of ['growatt_frames', 'growatt_events', 'growatt_cloud_calls', 'homewizard_calls', 'weather_calls']) assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
    assert.equal(repository.currentInverters()[0].power_w, 250);
    assert.equal(repository.currentCloudInverters()[0].power_w, 250);
    assert.equal(repository.countCalls('2026-10-17'), 1);
    assert.equal(repository.lastSuccessfulWeatherCall().forecast_rows, 12);
    assert.equal(repository.diagnosticState('growatt', 'cloud_last_request').http_status, 200);
    assert.equal(repository.diagnosticState('homewizard', 'p1').status, 'ok');
    writeFileSync(path, JSON.stringify({ logging: { ...defaultDebugConfiguration().logging, growatt: true, max_entries_per_source: 100 } }));
    assert.equal(repository.loggingStatus('growatt').enabled, true);
    assert.equal(repository.loggingStatus('growatt').max_entries, 100);
    repository.saveGrowattEvent(at, 'local', 'reply_sent', 'ACK');
    assert.equal(db.prepare('SELECT count(*) AS count FROM growatt_events').get().count, 1);
    assert.equal(repository.loggingStatus('weather').enabled, false);
    writeFileSync(path, '{');
    repository.saveGrowattEvent(at + 1, 'local', 'reply_sent', 'ACK');
    assert.equal(db.prepare('SELECT count(*) AS count FROM growatt_events').get().count, 1);
    assert.match(repository.loggingStatus('growatt').error, /debug.json/);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('dashboard-logschakelaars schrijven debug.json en behouden hun instelling met een nieuwe database', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-debug-http-')), path = join(folder, 'debug.json');
  const { settings: defaults, panels, panel_errors: panelErrors } = loadConfiguration();
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 } };
  const db = openDatabase(':memory:'), debug = createDebugConfiguration(path), repository = createRepository(db, debug);
  const server = startHttpServer({ settings, panels, panelErrors, repository, weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const source of ['growatt', 'weather', 'homewizard']) {
      assert.equal((await (await fetch(`${base}/intern/api/v1/${source}/logging`)).json()).enabled, false);
      assert.equal((await (await fetch(`${base}/intern/api/v1/${source}/logging?enabled=true`, { method: 'PUT' })).json()).enabled, true);
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).logging[source], true);
    }
    const replacement = openDatabase(':memory:');
    try {
      const fresh = createRepository(replacement, createDebugConfiguration(path));
      for (const source of ['growatt', 'weather', 'homewizard']) assert.equal(fresh.loggingStatus(source).enabled, true);
      assert.equal(replacement.prepare('SELECT count(*) AS count FROM diagnostic_settings').get().count, 0);
    } finally { replacement.close(); }
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(folder, { recursive: true, force: true }); }
});
