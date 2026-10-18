import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { loadConfiguration } from '../src/config/load.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { offlineSunTimes } from '../src/weather/solar-position.js';
import { createHomeWizardPoller } from '../src/homewizard/poller.js';
import { startHttpServer } from '../src/api/http-server.js';

test('weerlogs wissen en uitschakelen behoudt quota, planning en actuele status na herstart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-log-state-'));
  const path = join(folder, 'data.sqlite');
  let db = openDatabase(path);
  try {
    const repository = createRepository(db);
    const { settings: defaults, panels } = loadConfiguration();
    const day = '2026-10-16';
    const sun = offlineSunTimes(day, 52, 5);
    const now = (sun.sunrise_ms + sun.sunset_ms) / 2;
    const settings = { ...defaults, location: { latitude: 52, longitude: 5 }, weather: { ...defaults.weather, max_requests_per_local_day: 2 } };
    let resolveRequest;
    const weather = createWeatherScheduler({ settings, panels, panelErrors: ['test'], repository, clock: () => now,
      source: () => new Promise((resolve) => { resolveRequest = resolve; }) });
    const pending = weather.refresh();
    assert.equal(repository.countCalls(day), 1);
    repository.setLogging('weather', false);
    assert.equal(repository.clearWeatherDiagnostics().calls_deleted, 1);
    resolveRequest({ rows: [], sun: [{ day, ...sun }] });
    await pending;
    assert.equal(repository.recentWeatherCalls('all', 10, 0).rows.length, 0);
    assert.equal(repository.lastSuccessfulWeatherCall().status, 'ok');
    assert.equal((await weather.tick()).reason, 'interval');
    const again = weather.refresh();
    resolveRequest({ rows: [], sun: [{ day, ...sun }] });
    await again;
    assert.equal((await weather.refresh()).reason, 'quota');
    assert.equal(repository.countCalls(day), 2);
    db.close(); db = openDatabase(path);
    const restarted = createRepository(db);
    assert.equal(restarted.loggingStatus('weather').enabled, false);
    assert.equal(restarted.countCalls(day), 2);
    assert.equal(restarted.lastCall().status, 'ok');
    assert.equal(restarted.recentWeatherCalls('all', 10, 0).rows.length, 0);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('begrensde Growatt-logs bewaren omvormermetingen en hun koppeling wordt veilig losgelaten', () => {
  const db = openDatabase(':memory:');
  try {
    const repository = createRepository(db, { max_entries_per_source: 100 });
    const id = repository.saveFrame(1, 'local', 6, '5004', 'decoded', Buffer.alloc(16));
    repository.saveInverter({ serial: 'TEST123456', measured_ms: 1, received_ms: 1, power_w: 200, energy_today_kwh: 1, energy_total_kwh: 2, frame_id: id });
    for (let i = 2; i <= 200; i++) repository.saveGrowattEvent(i, 'local', 'reply_sent', 'antwoord');
    assert.equal(repository.currentInverters()[0].power_w, 200);
    assert.equal(repository.currentInverters()[0].frame_id, null);
    const timeline = repository.growattTimeline({ limit: 1000, offset: 0, type: '', address: '', view: 'all' });
    assert.equal(timeline.rows.length, 100);
    repository.setLogging('growatt', false);
    assert.equal(repository.saveFrame(201, 'local', 6, '5004', 'control', Buffer.alloc(16)), null);
    repository.saveGrowattEvent(202, 'local', 'reply_sent', 'uit');
    assert.equal(repository.growattTimeline({ limit: 1000, offset: 0, type: '', address: '', view: 'all' }).rows.length, 100);
    assert.equal(repository.diagnosticState('growatt', 'last_received').received_ms, 201);
  } finally { db.close(); }
});

test('HomeWizard toont lokale informatie en fouten, logbeheer behoudt metingen en actuele apparaatstatus', async () => {
  const { settings: defaults, panels, panel_errors: panelErrors } = loadConfiguration();
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, homewizard: { ...defaults.homewizard,
    p1: { ...defaults.homewizard.p1, host: '192.168.2.220' }, kwh: { ...defaults.homewizard.kwh, host: '192.168.2.221' } } };
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  let attempts = 0;
  const homewizard = createHomeWizardPoller(settings, repository, async (device) => {
    attempts++;
    if (device === 'p1') throw new Error('HomeWizard time-out');
    return { device, measured_ms: Date.now() - 1000 + attempts, received_ms: Date.now(), net_power_w: -50, import_kwh: 100, export_kwh: 10 };
  });
  const server = startHttpServer({ settings, panels, panelErrors, repository, homewizard, weather: { status: () => ({}) } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/intern/homewizard`)).status, 200);
    assert.equal((await fetch(`${base}/intern/homewizard.js`)).status, 200);
    assert.equal((await fetch(`${base}/intern/diagnostic-controls.js`)).status, 200);
    assert.equal((await fetch(`${base}/intern/api/v1/homewizard/poll`, { method: 'POST' })).status, 200);
    const overview = await (await fetch(`${base}/intern/api/v1/homewizard`)).json();
    assert.equal(overview.calls.rows.length, 2);
    assert.equal(overview.devices[0].error, 'HomeWizard time-out');
    assert.equal(overview.devices[1].measurement.net_power_w, -50);
    assert.equal(overview.selected_device, 'kwh');
    assert.equal(overview.net_power_w, -50);
    assert.equal(overview.devices[1].request_url, 'http://192.168.2.221/api/v1/data');
    assert.equal((await (await fetch(`${base}/intern/api/v1/homewizard?status=error&device=p1`)).json()).calls.rows.length, 1);
    for (const source of ['homewizard', 'weather', 'growatt']) {
      assert.equal((await (await fetch(`${base}/intern/api/v1/${source}/logging?enabled=false`, { method: 'PUT' })).json()).enabled, false);
      assert.equal((await (await fetch(`${base}/intern/api/v1/${source}/logging`)).json()).enabled, false);
    }
    await fetch(`${base}/intern/api/v1/homewizard/poll`, { method: 'POST' });
    assert.equal(repository.recentHomeWizardCalls({ status: 'all', device: 'all', limit: 10, offset: 0 }).rows.length, 2);
    assert.equal((await (await fetch(`${base}/intern/api/v1/homewizard/diagnostics`, { method: 'DELETE' })).json()).calls_deleted, 2);
    assert.equal(repository.currentMeters().length, 1);
    assert.equal(repository.history('kwh', 0, Date.now(), 10).length, 2);
    assert.equal(repository.diagnosticState('homewizard', 'p1').status, 'error');
    assert.equal((await fetch(`${base}/intern/api/v1/homewizard?device=unknown`)).status, 400);
    assert.equal((await fetch(`${base}/intern/api/v1/weather/logging?enabled=yes`, { method: 'PUT' })).status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});
