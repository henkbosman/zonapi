import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socketConfig, socketConfigKey, socketFreshnessMs } from '../src/appliances/socket-config.js';
import { updateSocketActivity, socketActivity } from '../src/appliances/socket-activity.js';
import { validateProfile } from '../src/appliances/load-profiles.js';
import { normalizeMeter, requestV1 } from '../src/homewizard/client.js';
import { createSocketPoller } from '../src/homewizard/socket-poller.js';
import { createHomeWizardPoller } from '../src/homewizard/poller.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { startHttpServer } from '../src/api/http-server.js';
import { loadConfiguration } from '../src/config/load.js';

/** Maakt een klein geldig apparaatprofiel met socket; input: id en optionele herkenningsgrenzen; output: profielobject. */
function profile(id = 'wasmachine', options = {}) {
  return { id, name: id, steps: [{ duration_minutes: 60, power_w: 1000 }], homewizard: { host: `${id}.local`, ...options } };
}

/** Maakt een tijdelijke installatie zonder echte LAN-verzoeken; input: optionele logging; output: instellingen, schrijfbare profielenmap en opslag. */
function fixture(logging = false) {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-sockets-')), directory = join(folder, 'appliances');
  mkdirSync(directory);
  const db = openDatabase(join(folder, 'test.sqlite'));
  const repository = createRepository(db, { homewizard: logging });
  repository.setLogging('homewizard', logging);
  const { settings } = loadConfiguration();
  settings.homewizard.poll_seconds = 10;
  return { folder, directory, db, repository, settings,
    write(value) { writeFileSync(join(directory, `${value.id}.json`), JSON.stringify(value)); },
    close() { db.close(); rmSync(folder, { recursive: true, force: true }); } };
}

test('socketinstellingen zijn optioneel en wijzen ongeldige adressen, drempels en wachttijden expliciet af', () => {
  assert.equal(socketConfig({}), null);
  assert.equal(socketConfig({ homewizard: { host: '' } }), null);
  assert.deepEqual(socketConfig(profile()), { host: 'wasmachine.local', api: 'v1', start_threshold_w: 10, stop_threshold_w: 5, start_delay_seconds: 30, stop_delay_seconds: 300 });
  assert.equal(socketConfig(profile('droger', { host: ' 192.168.2.123 ' })).host, '192.168.2.123');
  assert.deepEqual(validateProfile(profile()), []);
  for (const options of [{ host: 'http://192.168.2.123/api' }, { host: 1 }, { api: 'v2' }, { start_threshold_w: 0 }, { start_threshold_w: '10' },
    { stop_threshold_w: 10 }, { stop_threshold_w: -1 }, { start_delay_seconds: -1 }, { stop_delay_seconds: 3601 }, { start_delay_seconds: 1.5 }]) {
    assert.ok(validateProfile(profile('wasmachine', options)).length > 0, JSON.stringify(options));
  }
  assert.equal(socketFreshnessMs(5), 120000);
  assert.equal(socketFreshnessMs(90), 270000);
});

test('een echte start wordt bevestigd; een korte piek of programmapauze beëindigt geen programma', () => {
  const config = socketConfig(profile());
  let state, at = Date.parse('2026-10-17T09:00:00Z');
  const base = at;
  const observe = (seconds, power) => { at = base + seconds * 1000; state = updateSocketActivity(state, power, config, at, 120000); return state; };
  assert.equal(observe(0, 2).running, false);
  assert.equal(observe(10, 80).running, false);
  assert.equal(observe(20, 2).pending_start_ms, null);
  assert.equal(observe(30, 150).running, false);
  assert.equal(observe(50, 170).running, false);
  assert.equal(observe(60, 1900).running, true);
  assert.equal(state.started_ms, base + 30000);
  assert.equal(observe(70, 0).running, true);
  assert.equal(observe(170, 0).running, true);
  assert.equal(observe(180, 7).pending_stop_ms, null);
  assert.equal(observe(190, 0).running, true);
  for (const seconds of [290, 390, 480]) assert.equal(observe(seconds, 0).running, true);
  assert.equal(observe(490, 0).running, false);
  assert.equal(state.stopped_ms, base + 490000);
  assert.equal(observe(500, 20).running, false);
  assert.equal(observe(530, 20).running, true);
  assert.equal(state.started_ms, base + 500000);
});

test('meetgaten en mislukte reads tellen niet mee als aaneengesloten start- of stoptijd', () => {
  const config = socketConfig(profile());
  const at = Date.parse('2026-10-17T09:00:00Z');
  const first = updateSocketActivity(null, 100, config, at, 120000);
  const afterGap = updateSocketActivity(first, 100, config, at + 300000, 120000);
  assert.equal(afterGap.running, false);
  assert.equal(afterGap.pending_start_ms, at + 300000);
  const afterError = updateSocketActivity({ ...first, error: 'time-out' }, 100, config, at + 40000, 120000);
  assert.equal(afterError.running, false);
  assert.equal(afterError.pending_start_ms, at + 40000);
  assert.throws(() => updateSocketActivity(first, NaN, config, at + 50000, 120000), /vermogen/);
  const immediate = { ...config, start_delay_seconds: 0, stop_delay_seconds: 0 };
  const on = updateSocketActivity(null, 100, immediate, at, 120000);
  assert.equal(on.running, true);
  assert.equal(updateSocketActivity(on, 0, immediate, at + 10000, 120000).running, false);
});

test('socketuitlezing gebruikt v1-vermogen; sockets blijven buiten de netmeters en werken met logging uit', async () => {
  const f = fixture(false);
  let at = Date.parse('2026-10-17T09:00:00Z'), power = 1200;
  const requests = [];
  f.write(profile());
  f.write({ id: 'zonder_socket', name: 'Zonder socket', steps: [{ duration_minutes: 10, power_w: 100 }] });
  const reader = async (device, config) => {
    const body = await requestV1(config, async (url, options) => {
      requests.push(url);
      assert.ok(!options.method || options.method === 'GET');
      return { ok: true, json: async () => ({ active_power_w: power, total_power_import_kwh: 12.5 }) };
    });
    return normalizeMeter(device, config.api, body, at);
  };
  const poller = createSocketPoller(f.settings, f.repository, f.directory, reader, () => at);
  try {
    const p1 = normalizeMeter('p1', 'v1', { active_power_w: -10 }, at);
    f.repository.saveMeter(p1);
    assert.equal((await poller.poll()).sockets, 1);
    assert.equal(socketActivity(profile(), f.repository, 10, at).state, 'starting');
    for (let index = 1; index <= 40; index++) { at += 10000; await poller.poll(); }
    const activity = socketActivity(profile(), f.repository, 10, at);
    assert.equal(activity.state, 'running');
    assert.equal(activity.power_w, 1200);
    assert.equal(activity.started_at, '2026-10-17T09:00:00.000Z');
    assert.deepEqual(f.repository.currentMeters().map((row) => [row.device, row.net_power_w]), [['p1', -10]]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM appliance_socket_state').get().n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM homewizard_calls').get().n, 0);
    assert.equal(f.repository.diagnosticState('homewizard', 'socket:wasmachine').measurement.import_kwh, 12.5);
    assert.ok(requests.every((url) => url === 'http://wasmachine.local/api/v1/data'));
    power = 0; at += 10000; await poller.poll();
    assert.equal(socketActivity(profile(), f.repository, 10, at).running, true);
  } finally { await poller.stop(); f.close(); }
});

test('een onbereikbare socket stopt andere sockets en P1 niet; herstel begint een nieuwe bevestiging', async () => {
  const f = fixture();
  f.write(profile('wasmachine')); f.write(profile('droger'));
  let at = Date.parse('2026-10-17T09:00:00Z'), failing = true;
  const reader = async (device) => {
    if (device === 'socket:wasmachine' && failing) throw new Error('HomeWizard time-out');
    return normalizeMeter(device, 'v1', { active_power_w: 150 }, at);
  };
  const sockets = createSocketPoller(f.settings, f.repository, f.directory, reader, () => at);
  const meters = createHomeWizardPoller({ homewizard: { ...f.settings.homewizard, p1: { host: 'p1.local', api: 'v1' }, kwh: { host: '' } } }, f.repository, reader);
  try {
    await Promise.all([sockets.poll(), meters.poll()]);
    at += 30000; await sockets.poll();
    assert.equal(socketActivity(profile('droger'), f.repository, 10, at).running, true);
    assert.equal(socketActivity(profile('wasmachine'), f.repository, 10, at).state, 'unavailable');
    assert.match(socketActivity(profile('wasmachine'), f.repository, 10, at).error, /time-out/);
    assert.equal(f.repository.currentMeters()[0].device, 'p1');
    failing = false; at += 10000; await sockets.poll();
    assert.equal(socketActivity(profile('wasmachine'), f.repository, 10, at).state, 'starting');
    at += 30000; await sockets.poll();
    assert.equal(socketActivity(profile('wasmachine'), f.repository, 10, at).running, true);
    failing = true; at += 10000; await sockets.poll();
    assert.equal(socketActivity(profile('wasmachine'), f.repository, 10, at).running, null);
    assert.equal(socketActivity(profile('droger'), f.repository, 10, at + 120001).running, null);
  } finally { await sockets.stop(); f.close(); }
});

test('nieuwe IP-adressen, grenzen en uitschakeling worden zonder herstart gelezen en nemen geen oude aanstatus over', async () => {
  const f = fixture();
  let at = Date.parse('2026-10-17T09:00:00Z');
  const configured = profile('wasmachine', { start_delay_seconds: 0 }); f.write(configured);
  const seen = [];
  const poller = createSocketPoller(f.settings, f.repository, f.directory, async (device, config) => {
    seen.push(config.host); return normalizeMeter(device, 'v1', { active_power_w: 30 }, at);
  }, () => at);
  try {
    await poller.poll();
    assert.equal(socketActivity(configured, f.repository, 10, at).running, true);
    const replacement = profile('wasmachine', { host: '192.168.2.124', start_delay_seconds: 30 }); f.write(replacement);
    assert.equal(socketActivity(replacement, f.repository, 10, at).state, 'waiting');
    at += 10000; await poller.poll();
    assert.equal(socketActivity(replacement, f.repository, 10, at).state, 'starting');
    assert.deepEqual(seen, ['wasmachine.local', '192.168.2.124']);
    const disabled = profile('wasmachine', { host: '' }); f.write(disabled);
    assert.equal((await poller.poll()).sockets, 0);
    assert.equal(socketActivity(disabled, f.repository, 10, at).state, 'not_configured');
    assert.equal(seen.length, 2);
    f.write(profile('wasmachine', { stop_threshold_w: 20 }));
    const invalid = await poller.poll();
    assert.equal(invalid.sockets, 0);
    assert.match(invalid.errors[0].errors.join(' '), /stop_threshold_w/);
  } finally { await poller.stop(); f.close(); }
});

test('een recente programmaherkenning overleeft herstart en logs wissen; een v3-database wordt zonder meetverlies aangevuld', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-socket-migration-')), path = join(folder, 'test.sqlite');
  let db = openDatabase(path);
  try {
    let repository = createRepository(db);
    const at = Date.parse('2026-10-17T09:00:00Z');
    repository.saveMeter(normalizeMeter('p1', 'v1', { active_power_w: -50 }, at));
    db.exec('DROP TABLE appliance_socket_state; PRAGMA user_version=3');
    db.close(); db = openDatabase(path); repository = createRepository(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
    assert.equal(repository.currentMeters()[0].net_power_w, -50);
    const configured = profile('wasmachine', { start_delay_seconds: 0 }), config = socketConfig(configured);
    repository.saveApplianceSocketState({ appliance_id: configured.id, config_key: socketConfigKey(config), updated_ms: at,
      state: updateSocketActivity(null, 100, config, at, 120000) });
    db.close(); db = openDatabase(path); repository = createRepository(db);
    repository.clearHomeWizardDiagnostics();
    assert.equal(socketActivity(configured, repository, 10, at + 10000).running, true);
    assert.equal(socketActivity(configured, repository, 10, at + 120001).state, 'unavailable');
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('ingeschakelde socketlogs delen het bestaande HomeWizard-logbeheer zonder herkenning te wissen', async () => {
  const f = fixture(true), configured = profile('wasmachine', { start_delay_seconds: 0 }); f.write(configured);
  const at = Date.parse('2026-10-17T09:00:00Z');
  const poller = createSocketPoller(f.settings, f.repository, f.directory, async (device) => normalizeMeter(device, 'v1', { active_power_w: 30 }, at), () => at);
  try {
    await poller.poll();
    const page = f.repository.recentHomeWizardCalls({ status: 'all', device: 'all', limit: 10, offset: 0 });
    assert.equal(page.rows[0].device, 'socket:wasmachine');
    assert.equal(page.rows[0].measurement.net_power_w, 30);
    f.repository.clearHomeWizardDiagnostics();
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM homewizard_calls').get().n, 0);
    assert.equal(socketActivity(configured, f.repository, 10, at).running, true);
  } finally { await poller.stop(); f.close(); }
});

test('overlappende rondes worden overgeslagen en afsluiten wacht op een lopende socketaanvraag', async () => {
  const f = fixture(); f.write(profile());
  const at = Date.parse('2026-10-17T09:00:00Z');
  let finish;
  const poller = createSocketPoller(f.settings, f.repository, f.directory, (device) => new Promise((resolve) => {
    finish = () => resolve(normalizeMeter(device, 'v1', { active_power_w: 300 }, at));
  }), () => at);
  try {
    const pending = poller.poll();
    assert.deepEqual(await poller.poll(), { attempted: false, reason: 'busy' });
    let closed = false;
    const closing = poller.stop().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false);
    finish(); await pending; await closing;
    assert.equal(closed, true);
    assert.deepEqual(await poller.poll(), { attempted: false, reason: 'stopped' });
    assert.ok(f.repository.applianceSocketState('wasmachine'));
  } finally { await poller.stop(); f.close(); }
});

test('het dashboardendpoint levert echte socketactiviteit naast onafhankelijke netmetingen en de ingestelde basislast', async () => {
  const f = fixture(), configured = profile('wasmachine', { start_delay_seconds: 0 }); f.write(configured);
  const at = Date.now(), config = socketConfig(configured);
  f.repository.saveMeter(normalizeMeter('p1', 'v1', { active_power_w: -10 }, at));
  f.repository.saveApplianceSocketState({ appliance_id: configured.id, config_key: socketConfigKey(config), updated_ms: at,
    state: updateSocketActivity(null, 1400, config, at, 120000) });
  const { panels, panel_errors: panelErrors } = loadConfiguration();
  const settings = { ...f.settings, http: { host: '127.0.0.1', port: 0 }, advice: { ...f.settings.advice, baseload_w: 400, reserve_w: 0 } };
  const server = startHttpServer({ settings, panels, panelErrors, repository: f.repository, profilesDirectory: f.directory,
    weather: { status: () => ({ source: 'open-meteo', location_configured: false }) }, homewizard: { status: () => ({ p1: null, kwh: null }) } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const appliances = await (await fetch(`${base}/api/v1/appliances`)).json();
    assert.equal(appliances.profiles.length, 1);
    assert.equal(appliances.profiles[0].activity.state, 'running');
    assert.equal(appliances.profiles[0].activity.power_w, 1400);
    const status = await (await fetch(`${base}/api/v1/status`)).json();
    assert.equal(status.baseload.power_w, 400);
    assert.equal(status.homewizard.net_power_w, -10);
    assert.equal(status.homewizard.meters.length, 1);
    const daily = await (await fetch(`${base}/api/v1/appliances/daily`)).json();
    assert.ok(daily.days.every((day) => day.appliances.length === 1));
    assert.equal((await fetch(`${base}/api/v1/appliances/wasmachine/advice`)).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); f.close(); }
});

test('HomeWizard-overzicht bevat ingestelde apparaten met actuele socketstatus en doorzoekbare eigen logs', async () => {
  const f = fixture(true), configured = { ...profile('wasmachine', { start_delay_seconds: 0 }), name: 'Wasmachine boven' };
  f.write(configured); f.write(profile('droger')); f.write({ ...profile('vaatwasser'), homewizard: { host: '' } });
  const at = Date.now();
  const sockets = createSocketPoller(f.settings, f.repository, f.directory, async (device) => {
    if (device === 'socket:droger') throw new Error('Socket niet bereikbaar');
    return normalizeMeter(device, 'v1', { active_power_w: 1600, total_power_import_kwh: 42 }, at);
  }, () => at);
  const { panels, panel_errors: panelErrors } = loadConfiguration();
  const server = startHttpServer({ settings: { ...f.settings, http: { host: '127.0.0.1', port: 0 } }, panels, panelErrors,
    repository: f.repository, profilesDirectory: f.directory, weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await sockets.poll();
    const data = await (await fetch(`${base}/api/v1/homewizard`)).json();
    assert.equal(data.devices.length, 4); assert.equal(data.net_power_w, null);
    const washer = data.devices.find((device) => device.device === 'socket:wasmachine');
    assert.equal(washer.name, 'Wasmachine boven'); assert.equal(washer.host, 'wasmachine.local');
    assert.equal(washer.activity.state, 'running'); assert.equal(washer.measurement.net_power_w, 1600);
    assert.equal(washer.measurement.import_kwh, 42); assert.equal(washer.measurement.fresh, true);
    assert.equal(data.devices.find((device) => device.device === 'socket:droger').error, 'Socket niet bereikbaar');
    const calls = await (await fetch(`${base}/api/v1/homewizard?device=socket:wasmachine`)).json();
    assert.equal(calls.calls.rows.length, 1); assert.equal(calls.calls.rows[0].device, washer.device);
    f.repository.clearHomeWizardDiagnostics();
    assert.equal((await (await fetch(`${base}/api/v1/homewizard`)).json()).devices.find((device) => device.device === washer.device).activity.running, true);
    f.write({ ...configured, homewizard: { host: 'nieuw.local' } });
    const changed = (await (await fetch(`${base}/api/v1/homewizard`)).json()).devices.find((device) => device.device === washer.device);
    assert.equal(changed.host, 'nieuw.local'); assert.equal(changed.activity.state, 'waiting');
    assert.equal(changed.measurement, null); assert.equal(changed.latest_call, null);
    assert.equal((await fetch(`${base}/api/v1/homewizard?device=socket:bad%3Bsql`)).status, 400);
  } finally { await sockets.stop(); await new Promise((resolve) => server.close(resolve)); f.close(); }
});
