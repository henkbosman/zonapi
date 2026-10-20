import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { startHttpServer } from '../src/api/http-server.js';
import { correctionModelKey } from '../src/pv/correction-key.js';
import { learnPvCorrection } from '../src/pv/learn-correction.js';
import { socketConfig, socketConfigKey } from '../src/appliances/socket-config.js';

const target = Date.parse('2026-10-18T12:15:00Z'), quarter = 900000;
const privateText = 'PRIVATE-ONLY-do-not-publish', serial = 'SECRET0001', host = '192.168.13.37';

/** Bouwt echte interne en openbare HTTP-routes met herkenbare privédetails en kwartiercorrecties; input: testcontext; output: dienst, opslag en aanvraaghelpers. */
async function fixture(t) {
  const { settings } = loadConfiguration();
  settings.http = { host: '127.0.0.1', port: 0 }; settings.location = { latitude: 52, longitude: 5 };
  settings.growatt = { ...settings.growatt, production_source: 'shinelink', expected_inverters: 1 };
  settings.advice = { ...settings.advice, baseload_w: 100, reserve_w: 100, min_solar_share: 1 };
  settings.pv = { calibration_factor: 1 };
  const panels = { inverters: [{ id: privateText, serial, ac_limit_w: 2000 }],
    groups: [{ id: 'private-group', inverter_id: privateText, count: 5, wp_per_panel: 400, loss_factor: 1, tilt_deg: 0, azimuth_deg: 180 }] };
  const now = target + 600000;
  t.mock.method(Date, 'now', () => now);
  const directory = mkdtempSync(join(tmpdir(), 'zonapi-public-'));
  const profile = { id: 'wasmachine', name: 'Wasmachine', homewizard: { host },
    private_extra: privateText, steps: [{ duration_minutes: 15, power_w: 750 }] };
  writeFileSync(join(directory, 'wasmachine.json'), JSON.stringify(profile));
  const db = openDatabase(':memory:'), repository = createRepository(db);
  for (let start = target - 2 * 3600000; start < target + 75 * 3600000; start += quarter) repository.saveForecast({ source: 'open-meteo',
    model: 'icon_d2', start_ms: start, end_ms: start + quarter, ghi: 500, dni: 0, dhi: 500, fetched_ms: now - 1200000 });
  for (let index = 0; index < 3; index++) repository.saveSun(`2026-10-${18 + index}`,
    target + index * 86400000 - quarter, target + index * 86400000 + quarter, 'test', now);
  const frame = repository.saveFrame(now - 60000, host, 6, '5004', 'decoded', Buffer.from(privateText));
  repository.saveInverter({ serial, measured_ms: now - 60000, received_ms: now, power_w: 1000, energy_today_kwh: 5, energy_total_kwh: 500, frame_id: frame });
  const learned = learnPvCorrection(repository, settings, panels, [], [{ serial, power_w: 500, measured_ms: target + 300000, source: 'shinelink' }], now, { target_ms: target, defer: false });
  assert.equal(learned.factor, 0.5);
  repository.saveDiagnosticState('growatt', 'pv_correction', { model_key: correctionModelKey(settings, panels), attempted_at: new Date(now).toISOString(),
    target_time: new Date(target).toISOString(), status: 'waiting_for_samples', received_samples: 2, message: privateText,
    moments: [{ time: new Date(target).toISOString(), complete: true, received_inverters: 1, expected_inverters: 1, serial, host }],
    diagnostics: { rejected_timing: 1, private_extra: privateText } });
  const key = socketConfigKey(socketConfig(profile));
  repository.saveApplianceSocketState({ appliance_id: profile.id, config_key: key, updated_ms: now,
    state: { running: false, started_ms: null, stopped_ms: null, pending_start_ms: null, pending_stop_ms: null,
      measured_ms: now, power_w: 0, error: `${privateText}: http://${host}/api/v1/data` } });
  for (const hours of [2, 1]) {
    const start = now - hours * 3600000;
    const id = db.prepare(`INSERT INTO appliance_cycles(appliance_id,config_key,started_ms,ended_ms,state,complete,gap_ms,last_ms,sample_count)
      VALUES(?,?,?,?,'completed',1,120000,?,2)`).run(profile.id, key, start, start + 60000, start + 60000).lastInsertRowid;
    for (const [at, power] of [[start, 500], [start + 60000, 100]]) db.prepare('INSERT INTO appliance_cycle_samples VALUES(?,?,?)').run(id, at, power);
  }
  const calls = { weather: 0, homewizard: 0, growatt: 0 };
  const dependencies = { settings, panels, panelErrors: [], repository, profilesDirectory: directory,
    weather: { status: () => ({ source: 'open-meteo', sunrise: new Date(target - quarter).toISOString(), sunset: new Date(target + quarter).toISOString(),
      used_requests: 1, max_requests: 12, next_fetch: new Date(now + 3600000).toISOString(),
      request_url: `https://example.test/${privateText}`, last_call: { private_extra: privateText }, last_error: privateText }),
    refresh: async () => { calls.weather++; return { attempted: true }; } },
    homewizard: { status: () => ({ p1: privateText }), poll: async () => { calls.homewizard++; return {}; } },
    growattCloud: { status: () => ({ token_env: privateText, plants: [{ serial, host }], last_error: privateText }),
      poll: async () => { calls.growatt++; return { attempted: true }; } } };
  const server = startHttpServer(dependencies);
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(directory, { recursive: true, force: true }); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options) => fetch(base + path, options);
  const get = async (path) => { const response = await request(path); assert.equal(response.status, 200, path); return response.json(); };
  return { ...dependencies, now, db, server, base, calls, request, get };
}

test('openbare snapshot behoudt alle dashboardgegevens en onafhankelijke dagcorrecties zonder interne configuratie of diagnosevelden', async (t) => {
  const f = await fixture(t), body = await f.get('/api/v1/dashboard');
  assert.equal(body.status.growatt.power_w, 1000); assert.equal(body.status.growatt.active_inverters, 1);
  assert.equal(body.status.baseload.power_w, 100); assert.equal(body.profiles.profiles[0].name, 'Wasmachine');
  assert.equal(body.profiles.profiles[0].activity.state, 'unavailable');
  assert.equal(body.profiles.profiles[0].activity.error, 'Geen actuele socketmeting beschikbaar');
  assert.equal(body.production.points.length, 1); assert.equal(body.production.points[0].power_w, 1000);
  assert.equal(body.forecasts.days.length, 3); assert.equal(body.cycles.appliances[0].current.points.length, 2);
  assert.equal(body.cycles.appliances[0].previous.points.length, 2);
  for (const index of [0, 1, 2]) {
    const slot = body.forecasts.days[index].slots.find((row) => Date.parse(row.end) === target + index * 86400000);
    assert.equal(slot.power_w, 500); assert.equal(slot.base_power_w, 1000); assert.equal(slot.automatic_correction_factor, 0.5);
    assert.equal(slot.correction_computed_at, new Date(f.now).toISOString());
  }
  for (const index of [1, 2]) {
    const day = body.daily.days[index].appliances[0];
    assert.equal(day.earliest_start, new Date(target + index * 86400000).toISOString());
    assert.equal(day.best.solar_share_percent, 100);
  }
  const latest = body.forecasts.days[0].automatic_correction;
  assert.equal(latest.latest.correction_percent, -50); assert.equal(latest.last_attempt.received_samples, 2);
  const text = JSON.stringify(body);
  for (const value of [privateText, host, serial, 'private-group', f.profilesDirectory]) assert.ok(!text.includes(value), value);
  const forbidden = new Set(['host', 'serial', 'model_key', 'config_key', 'database_path', 'request_url', 'response_json', 'raw_hex',
    'token_env', 'plants', 'devices', 'groups', 'steps', 'missing', 'message', 'private_extra']);
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) { assert.ok(!forbidden.has(key), key); inspect(item); }
  }
  inspect(body);
  assert.equal((await f.get('/intern/api/v1/appliances')).profiles[0].homewizard.host, host);
  assert.ok(JSON.stringify(await f.get('/intern/api/v1/status')).includes(privateText));
  assert.equal(f.repository.lastCall(), null); assert.deepEqual(f.calls, { weather: 0, homewizard: 0, growatt: 0 });
});

test('alle volledige leesroutes en beheerpagina’s bestaan alleen onder /intern; oude aliassen geven geen toegang', async (t) => {
  const f = await fixture(t);
  const full = ['/api/v1/status', '/api/v1/forecast', '/api/v1/forecast/day', '/api/v1/forecast/days', '/api/v1/irradiance', '/api/v1/pv/corrections',
    '/api/v1/production/current', '/api/v1/production/day', '/api/v1/meters/current', '/api/v1/appliances', '/api/v1/appliances/daily',
    '/api/v1/appliances/cycles', '/api/v1/appliances/wasmachine/advice', '/api/v1/database/tables', '/api/v1/database/rows?table=forecast',
    '/api/v1/history', '/api/v1/growatt', '/api/v1/growatt/cloud', '/api/v1/growatt/timeline', '/api/v1/growatt/logging',
    '/api/v1/weather', '/api/v1/homewizard'];
  for (const path of full) {
    assert.equal((await f.request(path)).status, 404, path);
    assert.equal((await f.request('/intern' + path)).status, 200, '/intern' + path);
  }
  for (const path of ['/growatt', '/weather', '/homewizard', '/database', '/database.js', '/growatt.js', '/weather.js', '/homewizard.js', '/diagnostic-controls.js']) {
    assert.equal((await f.request(path)).status, 404, path);
    assert.equal((await f.request('/intern' + path)).status, 200, '/intern' + path);
  }
  for (const path of ['/internals/api/v1/status', '/%69ntern/api/v1/status', '/api/v1/dashboard/intern', '/api/v1/dashboard/']) {
    assert.equal((await f.request(path, { headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Prefix': '/intern' } })).status, 404, path);
  }
  assert.equal((await f.request('/intern')).status, 200); assert.equal((await f.request('/intern/')).status, 200);
  const query = await f.get('/api/v1/dashboard?table=diagnostic_state&path=/intern/api/v1/database/rows');
  assert.ok(!JSON.stringify(query).includes(privateText));
});

test('openbare methoden kunnen geen ophaalrondes starten, logging wijzigen of gegevens wissen; interne bediening blijft werken', async (t) => {
  const f = await fixture(t);
  const actions = [['POST', '/api/v1/weather/refresh'], ['POST', '/api/v1/homewizard/poll'], ['POST', '/api/v1/growatt/cloud/poll'],
    ['PUT', '/api/v1/growatt/logging?enabled=false'], ['DELETE', '/api/v1/growatt/diagnostics']];
  const frames = f.repository.frameStatus();
  for (const [method, path] of [...actions, ...['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].map((method) => [method, '/api/v1/dashboard'])]) {
    assert.equal((await f.request(path, { method })).status, 405, method + ' ' + path);
  }
  assert.deepEqual(f.calls, { weather: 0, homewizard: 0, growatt: 0 });
  assert.deepEqual(f.repository.frameStatus(), frames); assert.equal(f.repository.loggingStatus('growatt').enabled, true);
  for (const [method, path] of actions) assert.equal((await f.request('/intern' + path, { method })).status, 200, path);
  assert.deepEqual(f.calls, { weather: 1, homewizard: 1, growatt: 1 });
  assert.equal(f.repository.loggingStatus('growatt').enabled, false);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM growatt_frames').get().count, 0);
});

test('dubbelzinnige ruwe verzoekpaden kunnen niet naar de interne namespace worden genormaliseerd', async (t) => {
  const f = await fixture(t);
  for (const path of ['/intern\\other/../', '//some-host/intern/api/v1/status', '/api/v1/dashboard/../../intern/api/v1/status', '/intern/%2e/api/v1/status']) {
    const result = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: f.server.address().port, path }, (response) => {
        const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(result.status, 400, path); assert.deepEqual(result.body, { error: 'Ongeldig verzoekpad' });
  }
  assert.deepEqual(f.calls, { weather: 0, homewizard: 0, growatt: 0 });
});

test('openbare fouten geven geen interne paden of ruwe bronfouten terug', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.weather, 'status', () => { throw new Error(`${privateText} ${host} /opt/zonapi/data/zonapi.sqlite`); });
  const response = await f.request('/api/v1/dashboard');
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: 'Dashboardgegevens niet beschikbaar' });
});

test('alle openbare en interne HTML-/moduleafhankelijkheden blijven bereikbaar in hun eigen namespace', async (t) => {
  const f = await fixture(t), pending = ['/', '/intern/growatt', '/intern/weather', '/intern/homewizard', '/intern/database'], seen = new Set();
  while (pending.length) {
    const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
    const response = await f.request(path); assert.equal(response.status, 200, path);
    const text = await response.text();
    if (path === '/') assert.doesNotMatch(text, /href="\/(?:intern|growatt|weather|homewizard|database)/);
    for (const [, dependency] of text.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) pending.push(dependency);
    for (const [, dependency] of text.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) pending.push(new URL(dependency, f.base + path).pathname);
  }
  assert.ok(seen.has('/chart-cursor.js')); assert.ok(seen.has('/intern/weather-chart.js')); assert.ok(seen.has('/intern/production-chart-series.js'));
});

test('de echte dashboardmodule tekent met uitsluitend de openbare snapshot en ververst zonder interne API-aanvragen', async (t) => {
  const f = await fixture(t), calls = [], intervals = [];
  function node(tagName) { return { tagName, clientWidth: 780, children: [], attributes: {}, listeners: {}, textContent: '',
    append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; },
    setAttribute(key, value) { this.attributes[key] = String(value); }, getAttribute(key) { return this.attributes[key] ?? null; },
    addEventListener(key, value) { this.listeners[key] = value; },
    getBoundingClientRect() { return { left: 0, width: 780 }; } }; }
  const ids = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/id="([^"]+)"/g)];
  const nodes = new Map(ids.map(([, id]) => [id, node('div')]));
  const document = { querySelector: (selector) => nodes.get(selector.slice(1)), getElementById: (id) => nodes.get(id),
    createElement: node, createElementNS: (_, tag) => node(tag) };
  const original = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver, fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  t.after(() => Object.assign(globalThis, original));
  Object.assign(globalThis, { document, ResizeObserver: undefined,
    fetch: (path, options) => { calls.push(path); return original.fetch(f.base + path, options); },
    setInterval: (callback, milliseconds) => { intervals.push({ callback, milliseconds }); return intervals.length; } });
  await import('../public/dashboard.js');
  for (let attempt = 0; nodes.get('connection').textContent === '' && attempt < 200; attempt++) await pause(5);
  assert.equal(nodes.get('connection').textContent, 'Online'); assert.equal(nodes.get('pv-now').textContent, '1.0 kW');
  for (const id of ['pv-chart', 'pv-chart-tomorrow', 'pv-chart-after-tomorrow', 'ghi-chart', 'history-chart', 'appliance-list', 'appliance-cycle-charts']) {
    assert.ok(nodes.get(id).children.length > 0, id);
  }
  nodes.get('connection').textContent = '';
  intervals.find((item) => item.milliseconds === 30000).callback();
  for (let attempt = 0; nodes.get('connection').textContent === '' && attempt < 200; attempt++) await pause(5);
  assert.deepEqual(calls, ['/api/v1/dashboard', '/api/v1/dashboard']);
  assert.equal(nodes.get('connection').textContent, 'Online');
});
