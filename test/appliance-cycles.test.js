import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { socketConfig, socketConfigKey } from '../src/appliances/socket-config.js';
import { updateSocketActivity } from '../src/appliances/socket-activity.js';
import { applianceCycleResponse } from '../src/api/appliance-cycles.js';
import { loadConfiguration } from '../src/config/load.js';
import { startHttpServer } from '../src/api/http-server.js';
import { createSocketPoller } from '../src/homewizard/socket-poller.js';
import { normalizeMeter } from '../src/homewizard/client.js';

const base = Date.parse('2026-10-17T09:00:00Z');

/** Bouwt een installatie met een socket en zonder debuglogs; input: optioneel databasepad en herkenningsvelden; output: opslag en simulatiehelpers. */
function fixture(path = ':memory:', options = {}) {
  const db = openDatabase(path), repository = createRepository(db);
  repository.setLogging('homewizard', false);
  const profile = { id: 'wasmachine', name: 'Wasmachine', steps: [{ duration_minutes: 90, power_w: 1000 }], homewizard: { host: 'wasmachine.local', ...options } };
  const config = socketConfig(profile), key = socketConfigKey(config);
  const { settings } = loadConfiguration();
  settings.homewizard.poll_seconds = 10;
  return { db, repository, profile, settings,
    read(seconds, power, failed = false) {
      const previous = repository.applianceSocketState(profile.id)?.state ?? null;
      const at = base + seconds * 1000;
      const state = failed ? { ...previous, error: 'time-out', pending_start_ms: null, pending_stop_ms: null }
        : updateSocketActivity(previous, power, config, at, 120000);
      repository.saveApplianceSocketState({ appliance_id: profile.id, config_key: key, updated_ms: at, state, max_gap_ms: 120000 });
      return state;
    },
    response(seconds) { return applianceCycleResponse(profile, repository, settings, base + seconds * 1000); }
  };
}

/** Doorloopt een volledig programma inclusief korte pauze en einde-bevestiging; input: context en verschuiving in seconden; output: void. */
function completedRun(f, offset = 0) {
  f.read(offset - 10, 1);
  for (const [second, power] of [[0, 100], [10, 300], [20, 1900], [30, 1800], [40, 0], [50, 150], [60, 600]]) f.read(offset + second, power);
  for (let second = 70; second <= 370; second += 10) f.read(offset + second, 0);
}

test('cyclus begint bij de eerste startmeting en bewaart de startbuffer; stand-by en korte pieken worden niet getoond', () => {
  const f = fixture();
  try {
    f.read(-20, 1); f.read(-10, 100); f.read(0, 1);
    assert.equal(f.response(0).current, null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM appliance_cycle_samples').get().n, 0);
    f.read(10, 100); f.read(20, 200); f.read(30, 300);
    assert.equal(f.response(30).current, null);
    f.read(40, 1900);
    const result = f.response(45);
    assert.equal(result.current.started_at, new Date(base + 10000).toISOString());
    assert.equal(result.current.state, 'active');
    assert.equal(result.current.complete, true);
    assert.equal(result.elapsed_seconds, 35);
    assert.equal(result.live, true);
    assert.deepEqual(result.current.points, [0, 10, 20, 30].map((elapsed_seconds, index) => ({ elapsed_seconds, power_w: [100, 200, 300, 1900][index], solar_power_w: null, grid_power_w: null })));
  } finally { f.db.close(); }
});

test('korte programmapauzes blijven in de cyclus; vijf minuten stopwachttijd wordt na afloop afgeknipt', () => {
  const f = fixture();
  try {
    completedRun(f);
    const result = f.response(370);
    assert.equal(result.current.state, 'completed');
    assert.equal(result.current.complete, true);
    assert.equal(result.current.duration_seconds, 70);
    assert.equal(result.elapsed_seconds, 70);
    assert.equal(result.current.ended_at, new Date(base + 70000).toISOString());
    assert.equal(result.current.points.find((point) => point.elapsed_seconds === 40).power_w, 0);
    assert.equal(result.current.points.at(-1).elapsed_seconds, 70);
    assert.ok(result.current.points.every((point) => point.elapsed_seconds <= 70));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM appliance_cycle_samples').get().n, 8);
    assert.equal(result.previous, null);
    assert.equal(result.live, false);
  } finally { f.db.close(); }
});

test('vorige volledige cyclus is de verwachting bij de volgende start en beide zijn op nul uitgelijnd', () => {
  const f = fixture();
  try {
    completedRun(f);
    for (let second = 1000; second <= 1040; second += 10) f.read(second, 1200);
    const result = f.response(1045);
    assert.equal(result.previous.state, 'completed');
    assert.equal(result.previous.duration_seconds, 70);
    assert.equal(result.previous.points[0].elapsed_seconds, 0);
    assert.equal(result.current.points[0].elapsed_seconds, 0);
    assert.equal(result.current.points[0].power_w, 1200);
    assert.equal(result.previous.points[0].power_w, 100);
    assert.equal(result.elapsed_seconds, 45);
    assert.equal(result.live, true);
    for (let second = 1050; second <= 1350; second += 10) f.read(second, 0);
    const completed = f.response(1350);
    assert.equal(completed.current.duration_seconds, 50);
    assert.equal(completed.previous.id, result.previous.id);
    assert.equal(completed.current.state, 'completed');
  } finally { f.db.close(); }
});

test('cyclusopslag blijft begrensd en oude samples worden met hun cyclus verwijderd; logs wissen laat de grafieken staan', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 5; index++) completedRun(f, index * 1000);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM appliance_cycles').get().n, 2);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM appliance_cycle_samples').get().n, 16);
    const before = f.response(4370);
    f.repository.clearHomeWizardDiagnostics();
    assert.deepEqual(f.response(4370), before);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM homewizard_calls').get().n, 0);
    for (let second = 5000; second <= 5030; second += 10) f.read(second, 200);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM appliance_cycles').get().n, 3);
    assert.equal(f.repository.currentMeters().length, 0);
  } finally { f.db.close(); }
});

test('wegvallende metingen bevriezen de voortgang; een onderbroken cyclus wordt niet de volgende verwachting', () => {
  const f = fixture();
  try {
    completedRun(f);
    for (let second = 1000; second <= 1030; second += 10) f.read(second, 900);
    f.read(1040, 0, true);
    const unavailable = f.response(1100);
    assert.equal(unavailable.live, false);
    assert.equal(unavailable.elapsed_seconds, 30);
    assert.equal(unavailable.activity.running, null);
    f.read(1300, 600);
    assert.equal(f.response(1300).current.state, 'interrupted');
    for (let second = 1310; second <= 1330; second += 10) f.read(second, 600);
    const next = f.response(1330);
    assert.equal(next.current.state, 'active');
    assert.equal(next.current.complete, false);
    assert.equal(next.previous.started_at, new Date(base).toISOString());
    assert.equal(next.current.points[0].elapsed_seconds, 0);
  } finally { f.db.close(); }
});

test('een bestaande v4-database behoudt socketstatus en netmetingen; lopende programma’s zonder gemeten begin zijn geen referentie', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-cycle-migration-')), path = join(folder, 'test.sqlite');
  let f = fixture(path);
  try {
    f.db.exec('DROP TABLE appliance_cycle_samples; DROP TABLE appliance_cycles; PRAGMA user_version=4');
    const state = updateSocketActivity(null, 300, { ...socketConfig(f.profile), start_delay_seconds: 0 }, base, 120000);
    f.db.prepare('INSERT INTO appliance_socket_state VALUES(?,?,?,?)').run(f.profile.id, socketConfigKey(socketConfig(f.profile)), base, JSON.stringify(state));
    f.repository.saveMeter(normalizeMeter('p1', 'v1', { active_power_w: -10 }, base));
    f.db.close(); f = fixture(path);
    assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(f.repository.currentMeters()[0].net_power_w, -10);
    f.read(30, 500);
    assert.equal(f.response(30).current.complete, false);
    for (let second = 40; second <= 340; second += 10) f.read(second, 0);
    for (let second = 1000; second <= 1030; second += 10) f.read(second, 500);
    assert.equal(f.response(1030).previous, null);
  } finally { f.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('herstart bewaart de lopende curve; onmiddellijke stop bevat ook het afsluitende nul-meetpunt', () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-cycle-restart-')), path = join(folder, 'test.sqlite');
  const options = { start_delay_seconds: 0, stop_delay_seconds: 0 };
  let f = fixture(path, options);
  try {
    f.read(-10, 1); f.read(0, 300); f.read(10, 1200);
    const id = f.response(10).current.id;
    f.db.close(); f = fixture(path, options);
    f.read(20, 900); f.read(30, 0);
    const result = f.response(30);
    assert.equal(result.current.id, id);
    assert.equal(result.current.state, 'completed');
    assert.equal(result.current.complete, true);
    assert.deepEqual(result.current.points.map((point) => point.power_w), [300, 1200, 900, 0]);
  } finally { f.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('een opslagfout draait zowel socketstatus als cyclusmetingen terug', () => {
  const f = fixture();
  try {
    f.read(0, 1);
    const before = f.repository.applianceSocketState(f.profile.id);
    f.db.exec("CREATE TRIGGER sample_error BEFORE INSERT ON appliance_cycle_samples BEGIN SELECT RAISE(ABORT,'simulated write error'); END");
    assert.throws(() => f.read(10, 1500), /simulated write error/);
    assert.deepEqual(f.repository.applianceSocketState(f.profile.id), before);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM appliance_cycles').get().n, 0);
  } finally { f.db.close(); }
});

test('een al draaiend apparaat bij de eerste uitlezing levert een gedeeltelijke curve en geen betrouwbare vorige cyclus', () => {
  const f = fixture();
  try {
    for (let second = 0; second <= 40; second += 10) f.read(second, 300);
    assert.equal(f.response(40).current.complete, false);
    for (let second = 50; second <= 350; second += 10) f.read(second, 0);
    for (let second = 1000; second <= 1030; second += 10) f.read(second, 500);
    const result = f.response(1030);
    assert.equal(result.current.complete, false);
    assert.equal(result.previous, null);
    f.read(1040, 0);
  } finally { f.db.close(); }
});

test('een cyclus van meer dan een etmaal wordt begrensd en niet eindeloos opnieuw aangemaakt', () => {
  const f = fixture(':memory:', { start_delay_seconds: 0 });
  try {
    f.read(-10, 1); f.read(0, 100);
    for (let second = 120; second <= 86400; second += 120) f.read(second, 100);
    f.read(86410, 100); f.read(86420, 100);
    const result = f.response(86420);
    assert.equal(result.current.state, 'interrupted');
    assert.equal(result.current.complete, false);
    assert.equal(result.current.duration_seconds, 86400);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM appliance_cycles').get().n, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM appliance_cycle_samples').get().n, 721);
  } finally { f.db.close(); }
});

test('cyclus-API gebruikt echte socketpolls, blijft lokaal en serveert grafiekmodules onder dezelfde beveiligingsheaders', async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'zonapi-cycle-api-'));
  writeFileSync(join(directory, 'wasmachine.json'), JSON.stringify(f.profile));
  let at = base, power = 200;
  const poller = createSocketPoller(f.settings, f.repository, directory, async (device) => normalizeMeter(device, 'v1', { active_power_w: power }, at), () => at);
  const { panels, panel_errors: panelErrors } = loadConfiguration();
  const server = startHttpServer({ settings: { ...f.settings, http: { host: '127.0.0.1', port: 0 } }, panels, panelErrors,
    repository: f.repository, profilesDirectory: directory, weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let second = 0; second <= 40; second += 10) { at = base + second * 1000; power += 100; await poller.poll(); }
    const response = await fetch(`${url}/intern/api/v1/appliances/cycles`), body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.appliances[0].current.points.length, 5);
    assert.equal(body.appliances[0].previous, null);
    assert.equal(body.appliances[0].current.points[0].elapsed_seconds, 0);
    for (const path of ['/appliance-cycle-chart.js', '/dashboard-appliance-charts.js', '/dashboard']) {
      const page = await fetch(url + path);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    }
  } finally { await poller.stop(); await new Promise((resolve) => server.close(resolve)); f.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
