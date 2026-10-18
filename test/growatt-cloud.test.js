import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration, validateSettings } from '../src/config/load.js';
import { growattCloudConfig, growattCloudToken } from '../src/growatt/cloud/config.js';
import { createGrowattCloudClient } from '../src/growatt/cloud/client.js';
import { createGrowattCloudPoller } from '../src/growatt/cloud/poller.js';
import { normalizeGrowattCloud } from '../src/growatt/cloud/normalize.js';
import { growattTimestamp } from '../src/growatt/cloud/timestamp.js';
import { currentProductionRows, productionHistory } from '../src/production/source.js';
import { productionResponse } from '../src/api/measurements.js';
import { getBaseload } from '../src/appliances/baseload.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { startHttpServer } from '../src/api/http-server.js';

const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];
const minute = 60000;
const secret = 'private/growatt-token+value';

/** Bouwt een onafhankelijke testinstallatie; input: bronkeuze en optionele cloudvelden; output: instellingen en panelen met vier configureerbare omvormers. */
function fixture(source = 'cloud', cloud = {}) {
  const { settings: defaults } = loadConfiguration();
  return { settings: { ...defaults, http: { host: '127.0.0.1', port: 0 }, location: { latitude: 52, longitude: 5 },
    growatt: { ...defaults.growatt, production_source: source, cloud: { token: secret, ...cloud } } },
  panels: { expected_panel_count: 20, inverters: serials.map((serial, index) => ({ serial, id: `mic-${index}`, ac_limit_w: 2000 })),
    groups: serials.map((serial, index) => ({ id: `zuid-${index}`, inverter_id: `mic-${index}`, count: 5, wp_per_panel: 400, tilt_deg: 14, azimuth_deg: 180, loss_factor: 0.9 })) } };
}

/** Maakt één gedocumenteerd v4-MIN-antwoord; input: serial, meettijd en optioneel vermogen; output: succesantwoord met echte meettijd en energietellers. */
function answer(serial, at, power = 250) {
  return { code: 0, message: 'SUCCESSFUL_OPERATION', data: { min: [{ serialNum: serial, calendar: at, pac: String(power), eacToday: '2.1', eacTotal: '1234.5' }] } };
}

/** Maakt een al genormaliseerde meting voor opslag; input: serial, meettijd, vermogen en optionele ontvangsttijd; output: meetobject zonder framekoppeling. */
function measured(serial, at, power = 250, received = at) {
  return { serial, measured_ms: at, received_ms: received, power_w: power, energy_today_kwh: 2, energy_total_kwh: 100, frame_id: null };
}

test('bestaande configuraties gebruiken alleen ShineLink; cloudvelden zijn optioneel, gevalideerd en lezen een token uit de omgeving', async () => {
  const { settings, panels } = fixture();
  const legacy = { ...settings, growatt: { ...settings.growatt } };
  delete legacy.growatt.production_source;
  delete legacy.growatt.cloud;
  assert.equal(growattCloudConfig(legacy).source, 'shinelink');
  assert.deepEqual(validateSettings(legacy), []);
  assert.equal(growattCloudToken(growattCloudConfig(settings), {}), secret);
  assert.equal(growattCloudToken(growattCloudConfig(settings), { GROWATT_API_TOKEN: 'environment-token' }), 'environment-token');
  for (const cloud of [{ base_url: 'http://openapi.growatt.com' }, { base_url: 'https://user:pass@openapi.growatt.com' }, { base_url: 'https://openapi.growatt.com/?token=x' }, { poll_seconds: 10 }, { daylight_only: 'false' }, { timezone: 'invalid-zone' }, { device_type: 'storage' }]) {
    assert.ok(validateSettings(fixture('cloud', cloud).settings).some((error) => error.startsWith('growatt.cloud')));
  }
  assert.ok(validateSettings(fixture('unknown').settings).some((error) => error.includes('production_source')));
  assert.deepEqual(validateSettings({ ...settings, growatt: { ...settings.growatt, overview_group_seconds: 60 } }), []);
  assert.ok(validateSettings({ ...settings, growatt: { ...settings.growatt, overview_group_seconds: 0 } }).some((error) => error.includes('overview_group_seconds')));
  const db = openDatabase(':memory:');
  try {
    const poller = createGrowattCloudPoller({ settings: legacy, panels, repository: createRepository(db), environment: {},
      client: { read: () => { throw new Error('mag niet worden aangeroepen'); } } });
    assert.equal((await poller.poll()).reason, 'disabled');
    assert.equal(poller.status().enabled, false);
  } finally { db.close(); }
});

test('Growatt-token staat uitsluitend in de header; discovery en v4-meting gebruiken gedocumenteerde paden en verbergen geheimen in logs', async () => {
  const now = Date.parse('2026-10-16T13:00:00Z'), logs = [], requests = [];
  const config = growattCloudConfig(fixture().settings);
  const client = createGrowattCloudClient(config, secret, { clock: () => now, pause: async () => {}, onCall: (row) => logs.push(row),
    fetcher: async (url, options) => {
      requests.push({ url: url.toString(), options });
      assert.equal(options.headers.token, secret);
      assert.equal(options.redirect, 'error');
      assert.equal(url.toString().includes(secret), false);
      if (url.pathname === '/v1/plant/list') return Response.json({ error_code: 0, data: { count: 1, plants: [{ plant_id: 42, name: 'Thuis' }] } });
      if (url.pathname === '/v1/device/list') return Response.json({ error_code: 0, data: { count: 2, devices: [{ device_sn: serials[0], type: 7 }, { device_sn: 'METER00001', type: 3 }] } });
      assert.equal(url.pathname, '/v4/new-api/queryLastData');
      assert.equal(options.method, 'POST');
      assert.equal(new URLSearchParams(options.body).get('deviceSn'), serials[0]);
      assert.equal(new URLSearchParams(options.body).get('deviceType'), 'min');
      return Response.json({ ...answer(serials[0], now - minute), token: secret, message: `echo ${secret}`, nested: { password: 'do-not-store' } });
    } });
  assert.deepEqual(await client.plants(), [{ plant_id: '42', name: 'Thuis' }]);
  const devices = await client.devices('42');
  assert.deepEqual(devices, [{ serial: serials[0], device_type: 'min' }]);
  const row = await client.read(devices[0]);
  assert.equal(row.power_w, 250);
  assert.equal(row.energy_today_kwh, 2.1);
  assert.equal(row.measured_ms, now - minute);
  assert.equal(row.received_ms, now);
  assert.equal(requests.length, 3);
  assert.equal(logs.length, 3);
  assert.equal(logs[2].http_status, 200);
  assert.doesNotMatch(JSON.stringify(logs), /private\/growatt|do-not-store/);
  assert.match(logs[2].response_json, /verborgen/);
});

test('cloudnormalisatie bewaart nul maar verzint geen vermogen of meettijd; UTC en wintertijd blijven correct', () => {
  const now = Date.parse('2026-10-16T13:00:00Z'), device = { serial: serials[0], device_type: 'min' };
  assert.equal(normalizeGrowattCloud(answer(serials[0], now, 0).data, device, now, 'Europe/Amsterdam').power_w, 0);
  const invalidPower = answer(serials[0], now);
  invalidPower.data.min[0].pac = null;
  assert.throws(() => normalizeGrowattCloud(invalidPower.data, device, now, 'Europe/Amsterdam'), /pac ontbreekt/);
  assert.throws(() => normalizeGrowattCloud(answer(serials[1], now).data, device, now, 'Europe/Amsterdam'), /geen meting/);
  assert.throws(() => normalizeGrowattCloud(answer(serials[0], now + 3 * minute).data, device, now, 'Europe/Amsterdam'), /toekomst/);
  const undated = answer(serials[0], now);
  delete undated.data.min[0].calendar;
  assert.throws(() => normalizeGrowattCloud(undated.data, device, now, 'Europe/Amsterdam'), /meettijd/);
  assert.equal(growattTimestamp('2026-10-16 15:00:00', 'Europe/Amsterdam'), now);
  assert.equal(growattTimestamp('2026-10-16T15:00:00+02:00', 'Europe/Amsterdam'), now);
  assert.equal(growattTimestamp({ timeInMillis: now }, 'Europe/Amsterdam'), now);
  assert.equal(growattTimestamp(now / 1000, 'Europe/Amsterdam'), now);
  assert.equal(growattTimestamp('2026-10-25 02:30:00', 'Europe/Amsterdam'), null);
  assert.equal(growattTimestamp('2026-03-29 02:30:00', 'Europe/Amsterdam'), null);
  assert.equal(growattTimestamp('2026-02-30 12:00:00', 'Europe/Amsterdam'), null);
  const db = openDatabase(':memory:');
  try {
    const repository = createRepository(db);
    const stale = normalizeGrowattCloud(answer(serials[0], now - 60 * minute).data, device, now, 'Europe/Amsterdam');
    repository.saveCloudInverter(stale);
    repository.saveCloudInverter({ ...stale, received_ms: now + minute });
    assert.equal(repository.cloudInverterHistory(0, now + 1).length, 1);
    assert.equal(productionResponse(repository.currentCloudInverters(), 1, 12, now).active_inverters, 0);
  } finally { db.close(); }
});

test('poller slaat vier omvormers onafhankelijk op en behoudt het interval over een herstart', async () => {
  const { settings, panels } = fixture();
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-growatt-cloud-')), path = join(folder, 'state.sqlite');
  let db = openDatabase(path), now = Date.parse('2026-10-16T13:00:00Z'), calls = 0;
  const client = { read: async (device) => {
    calls++;
    if (device.serial === serials[2]) throw new Error('voorbeeldfout');
    return measured(device.serial, now - minute, 250, now);
  } };
  try {
    let repository = createRepository(db);
    let poller = createGrowattCloudPoller({ settings, panels, repository, clock: () => now, environment: {}, client });
    assert.equal((await poller.poll()).reason, 'partial');
    assert.equal(repository.currentCloudInverters().length, 3);
    assert.match(poller.status().last_error, /INV0000003.*voorbeeldfout/);
    assert.equal((await poller.poll()).reason, 'interval');
    assert.equal(calls, 4);
    db.close(); db = openDatabase(path); repository = createRepository(db);
    poller = createGrowattCloudPoller({ settings, panels, repository, clock: () => now, environment: {}, client });
    assert.equal((await poller.poll()).reason, 'interval');
    assert.equal(repository.currentCloudInverters().length, 3);
    now += 300000;
    await poller.poll();
    assert.equal(calls, 8);
    assert.equal(Date.parse(poller.status().next_fetch) - now, 600000);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('HTTP 429 en Growatt 501 worden gelogd met persistent Retry-After en zonder token in foutteksten', async () => {
  const { settings, panels } = fixture();
  let now = Date.parse('2026-10-16T13:00:00Z'), requests = 0;
  const db = openDatabase(':memory:');
  try {
    const repository = createRepository(db);
    const client = createGrowattCloudClient(growattCloudConfig(settings), secret, { clock: () => now, pause: async () => {}, onCall: repository.saveGrowattCloudCall,
      fetcher: async () => { requests++; return Response.json({ code: 501, message: `rate limited ${secret}`, token: secret }, { status: 429, headers: { 'Retry-After': '1200' } }); } });
    const poller = createGrowattCloudPoller({ settings, panels, repository, clock: () => now, environment: {}, client });
    assert.equal((await poller.poll()).reason, 'error');
    assert.equal(requests, 1);
    assert.equal(Date.parse(poller.status().next_fetch), now + 1200000);
    assert.doesNotMatch(JSON.stringify(poller.status()), /private\/growatt/);
    const log = repository.growattTimeline({ limit: 20, offset: 0, type: '', address: '', view: 'errors' });
    assert.ok(log.rows.some((row) => row.source === 'cloud' && row.detail.includes('HTTP 429')));
    now += 300000;
    const restart = createGrowattCloudPoller({ settings, panels, repository, clock: () => now, environment: {}, client });
    assert.equal((await restart.poll()).reason, 'interval');
    assert.equal(requests, 1);
  } finally { db.close(); }
});

test('automatische bronkeuze kiest recente ShineLink-data vóór cloud zonder dubbel te tellen; oude lokale data valt terug op cloud', () => {
  const { settings } = fixture('auto');
  const now = Date.parse('2026-10-16T13:00:00Z'), db = openDatabase(':memory:');
  try {
    const repository = createRepository(db);
    for (const serial of serials) {
      repository.saveCloudInverter(measured(serial, now - 2 * minute, 250, now));
      repository.saveInverter(measured(serial, now - (serial === serials[3] ? 30 : 3) * minute, 100, now - 2 * minute));
    }
    const chosen = currentProductionRows(repository, settings, now);
    assert.deepEqual(chosen.map((row) => row.source), ['shinelink', 'shinelink', 'shinelink', 'cloud']);
    const result = productionResponse(chosen, 4, 12, now);
    assert.equal(result.power_w, 550);
    assert.equal(result.active_inverters, 4);
    assert.equal(result.source, 'mixed');
    const cloud = currentProductionRows(repository, fixture('cloud').settings, now);
    assert.equal(productionResponse(cloud, 4, 12, now).power_w, 1000);
    const history = productionHistory(repository, settings, now - 60 * minute, now + 1);
    const keys = history.map((row) => `${row.serial}:${row.measured_ms}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(history.some((row) => row.serial === serials[3] && row.source === 'cloud'));
  } finally { db.close(); }
});

test('auto doet geen cloudverzoeken als vier lokale omvormers actueel zijn; discovery kiest geen willekeurige installatie', async () => {
  const { settings, panels } = fixture('auto');
  const now = Date.parse('2026-10-16T13:00:00Z'), db = openDatabase(':memory:');
  try {
    const repository = createRepository(db);
    for (const serial of serials) repository.saveInverter(measured(serial, now));
    let calls = 0;
    const client = { plants: async () => { calls++; return [{ plant_id: '1', name: 'Thuis' }, { plant_id: '2', name: 'Anders' }]; }, read: async () => { calls++; throw new Error('onverwacht'); } };
    const poller = createGrowattCloudPoller({ settings, panels, repository, clock: () => now, environment: {}, client });
    assert.equal((await poller.poll()).reason, 'local_fresh');
    assert.equal(calls, 0);
    const unknown = { ...panels, inverters: panels.inverters.map((item) => ({ ...item, serial: '' })) };
    const discovery = createGrowattCloudPoller({ settings: fixture('cloud').settings, panels: unknown, repository, clock: () => now, environment: {}, client });
    assert.equal((await discovery.poll()).reason, 'error');
    assert.match(discovery.status().last_error, /Meerdere installaties/);
    assert.equal(discovery.status().plants.length, 2);
    assert.equal(calls, 1);
  } finally { db.close(); }
});

test('basislast gebruikt de geselecteerde cloudmetingen en telt lokale kopieën niet mee', () => {
  const { settings } = fixture('cloud');
  const now = Date.parse('2026-10-16T13:00:00Z'), db = openDatabase(':memory:');
  try {
    const repository = createRepository(db);
    for (let index = 0; index < 12; index++) {
      const at = now - index * 300000;
      for (const serial of serials) {
        repository.saveCloudInverter(measured(serial, at, 100));
        repository.saveInverter(measured(serial, at, 999));
      }
      repository.saveMeter({ device: 'p1', measured_ms: at, received_ms: at, net_power_w: -200, import_kwh: 100, export_kwh: 10 });
    }
    assert.equal(getBaseload(settings, repository, now, serials).power_w, 200);
    assert.equal(getBaseload(fixture('shinelink').settings, repository, now, serials).power_w, 3796);
  } finally { db.close(); }
});

test('API, daggrafiek en Growatt-tijdlijn gebruiken clouddata; logbeheer behoudt metingen en actuele status', async (t) => {
  const { settings, panels } = fixture('cloud');
  const now = Math.floor(Date.now() / 900000) * 900000, db = openDatabase(':memory:');
  t.mock.method(Date, 'now', () => now);
  const repository = createRepository(db);
  let requests = 0;
  const client = createGrowattCloudClient(growattCloudConfig(settings), secret, { clock: () => now, pause: async () => {}, onCall: repository.saveGrowattCloudCall,
    fetcher: async (url, options) => { requests++; return Response.json(answer(new URLSearchParams(options.body).get('deviceSn'), now - minute)); } });
  const cloud = createGrowattCloudPoller({ settings, panels, repository, clock: () => now, environment: {}, client });
  await cloud.poll();
  for (const serial of serials) repository.saveInverter(measured(serial, now - minute, 900));
  const server = startHttpServer({ settings, panels, panelErrors: [], repository, growattCloud: cloud,
    weather: { status: () => ({ sunrise: new Date(now - 3 * 60 * minute).toISOString(), sunset: new Date(now + 3 * 60 * minute).toISOString() }) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const current = await (await fetch(`${base}/intern/api/v1/production/current`)).json();
    assert.equal(current.power_w, 1000);
    assert.equal(current.source, 'cloud');
    assert.equal(current.production_source, 'cloud');
    const status = await (await fetch(`${base}/intern/api/v1/status`)).json();
    assert.equal(status.growatt.power_w, 1000);
    assert.equal(status.growatt.cloud.configured, true);
    assert.equal(JSON.stringify(status).includes(secret), false);
    const day = await (await fetch(`${base}/intern/api/v1/production/day`)).json();
    assert.equal(day.points.at(-1).power_w, 1000);
    assert.equal(day.points.at(-1).active_inverters, 4);
    assert.equal(day.points.at(-1).source, 'cloud');
    assert.equal(day.overview_group_seconds, 300);
    const overview = await (await fetch(`${base}/intern/api/v1/growatt`)).json();
    assert.deepEqual(overview.production.inverters, current.inverters);
    const local = await (await fetch(`${base}/intern/api/v1/history?metric=inverter&source=shinelink`)).json();
    assert.ok(local.rows.every((row) => row.power_w === 900 && row.source === 'shinelink'));
    const timeline = await (await fetch(`${base}/intern/api/v1/growatt/timeline?view=cloud`)).json();
    assert.equal(timeline.rows.length, 4);
    assert.ok(timeline.rows.every((row) => row.label === 'Web-API' && row.source === 'cloud'));
    const detail = await (await fetch(`${base}/intern/api/v1/growatt/cloud/calls/${timeline.rows[0].id}`)).json();
    assert.equal(JSON.parse(detail.response_json).data.min[0].pac, '250');
    assert.equal((await (await fetch(`${base}/intern/api/v1/growatt/timeline?type=xx04`)).json()).rows.length, 0);
    const page = await (await fetch(`${base}/intern/growatt`)).text();
    assert.match(page, /growatt\.js" type="module"/);
    assert.match(page, /Growatt-web-API/);
    assert.equal((await fetch(`${base}/intern/growatt-cloud.js`)).status, 200);
    assert.equal((await fetch(`${base}/intern/growatt-production.js`)).status, 200);
    assert.equal((await (await fetch(`${base}/intern/api/v1/growatt/cloud/poll`, { method: 'POST' })).json()).reason, 'interval');
    assert.equal(requests, 4);
    await fetch(`${base}/intern/api/v1/growatt/logging?enabled=false`, { method: 'PUT' });
    const cleared = await (await fetch(`${base}/intern/api/v1/growatt/diagnostics`, { method: 'DELETE' })).json();
    assert.equal(cleared.cloud_calls_deleted, 4);
    assert.equal(repository.currentCloudInverters().length, 4);
    assert.equal(cloud.status().state, 'ok');
    repository.saveGrowattCloudCall({ attempted_ms: now, method: 'POST', request_url: 'https://openapi.growatt.com/v4/new-api/queryLastData', status: 'ok', device_serial: serials[0], http_status: 200, duration_ms: 1, detail: null, response_json: '{}' });
    assert.equal((await (await fetch(`${base}/intern/api/v1/growatt/timeline`)).json()).rows.length, 0);
    assert.equal((await (await fetch(`${base}/intern/api/v1/production/current`)).json()).power_w, 1000);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});

test('cloudlogs delen de Growatt-limiet en verwijderen geen historische metingen', () => {
  const db = openDatabase(':memory:');
  try {
    const repository = createRepository(db, { max_entries_per_source: 100 });
    repository.saveCloudInverter(measured(serials[0], 1000));
    for (let index = 1; index <= 200; index++) repository.saveGrowattCloudCall({ attempted_ms: index, method: 'POST', request_url: 'https://openapi.growatt.com/v4/new-api/queryLastData', device_serial: serials[0], status: 'ok', http_status: 200, duration_ms: 1, detail: null, response_json: '{}' });
    assert.equal(repository.growattTimeline({ limit: 1000, offset: 0, type: '', address: '', view: 'all' }).rows.length, 100);
    repository.clearGrowattDiagnostics();
    assert.equal(repository.currentCloudInverters()[0].power_w, 250);
  } finally { db.close(); }
});

test('afsluiten breekt een lopend cloudverzoek af en wacht voordat de database sluit', async () => {
  const { settings, panels } = fixture();
  const db = openDatabase(':memory:');
  try {
    const repository = createRepository(db);
    let signal;
    const poller = createGrowattCloudPoller({ settings, panels, repository, clock: () => Date.parse('2026-10-16T13:00:00Z'), environment: {}, client: {
      read: (device, abortSignal) => new Promise((resolve, reject) => { signal = abortSignal; abortSignal.addEventListener('abort', () => reject(new Error('afgebroken')), { once: true }); })
    } });
    const pending = poller.poll();
    await Promise.resolve();
    assert.equal((await poller.poll()).reason, 'busy');
    await poller.stop();
    assert.equal((await pending).reason, 'stopped');
    assert.equal(signal.aborted, true);
    assert.equal(repository.currentCloudInverters().length, 0);
    assert.equal((await poller.poll()).reason, 'stopped');
  } finally { db.close(); }
});
