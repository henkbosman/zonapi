import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeGrowattCloud } from '../src/growatt/cloud/normalize.js';
import { createGrowattCloudClient } from '../src/growatt/cloud/client.js';
import { growattCloudConfig } from '../src/growatt/cloud/config.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { repairGrowattCloudTime } from '../src/storage/repair-growatt-cloud-time.js';
import { loadConfiguration } from '../src/config/load.js';
import { startHttpServer } from '../src/api/http-server.js';
import { renderGrowattProduction } from '../public/growatt-production.js';

const serial = 'INV0000001';
const device = { serial, device_type: 'min' };
const zone = 'Europe/Amsterdam';

/** Bouwt een Growatt-antwoord met uiteenlopende tijdvelden; input: lokale meettijd, kalender-UTC, serienummer en vermogen; output: v4-MIN-antwoord. */
function response(time = '2026-10-16 16:02:46', calendar = '2026-10-16T08:00:46Z', sn = serial, power = 250) {
  return { code: 0, data: { min: [{ serialNum: sn, time, calendar: Date.parse(calendar), pac: power, eacToday: 2, eacTotal: 200 }] } };
}

/** Maakt de minimale tabel-DOM voor de echte renderer; input: geen; output: document en elementenkaart. */
function tableDocument() {
  /** Maakt één element; input: optionele tag; output: node met tekst en kinderen. */
  function node(tagName = 'div') { return { tagName, textContent: '', children: [], append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; } }; }
  const nodes = new Map(['power', 'active', 'updated', 'production-source', 'inverters'].map((id) => [id, node()]));
  return { nodes, document: { getElementById: (id) => nodes.get(id), createElement: node } };
}

/** Bewaart een door de vorige versie verkeerd gedateerde rij met het oorspronkelijke bronantwoord; input: repository, API-antwoord en ontvangsttijd; output: opgeslagen legacy-rij. */
function saveLegacy(repository, body, received) {
  const item = body.data.min[0];
  const row = { ...normalizeGrowattCloud(body.data, { serial: item.serialNum, device_type: 'min' }, received, zone), measured_ms: item.calendar };
  repository.saveCloudInverter(row);
  repository.saveGrowattCloudCall({ attempted_ms: received - 5, duration_ms: 10, method: 'POST', request_url: 'https://openapi.growatt.com/v4/new-api/queryLastData',
    device_serial: row.serial, http_status: 200, status: 'ok', detail: null, response_json: JSON.stringify(body) });
  return row;
}

test('Growatt time bepaalt meettijd en meetvolgorde, ook als calendar zes uur en twee minuten afwijkt', () => {
  const received = Date.parse('2026-10-16T14:05:00Z');
  const body = response();
  assert.equal(normalizeGrowattCloud(body.data, device, received, zone).measured_ms, Date.parse('2026-10-16T14:02:46Z'));
  body.data.min.push({ ...body.data.min[0], time: '2026-10-16 16:03:46', calendar: Date.parse('2026-10-16T07:00:00Z'), pac: 300 });
  const latest = normalizeGrowattCloud(body.data, device, received, zone);
  assert.equal(latest.measured_ms, Date.parse('2026-10-16T14:03:46Z'));
  assert.equal(latest.power_w, 300);
});

test('cloudklokken volgen zomer- en wintertijd, expliciete offsets en lokale middernacht', () => {
  for (const [time, expected] of [
    ['2026-10-16 16:02:46', '2026-10-16T14:02:46Z'],
    ['2026-11-01 16:02:46', '2026-11-01T15:02:46Z'],
    ['2026-03-29 01:59:59', '2026-03-29T00:59:59Z'],
    ['2026-03-29 03:00:00', '2026-03-29T01:00:00Z'],
    ['2026-10-25 01:59:59', '2026-10-24T23:59:59Z'],
    ['2026-10-25 03:00:00', '2026-10-25T02:00:00Z'],
    ['2026-11-01 00:05:00', '2026-10-31T23:05:00Z'],
    ['2026-10-16T16:02:46+02:00', '2026-10-16T14:02:46Z'],
    ['2026-10-16T14:02:46Z', '2026-10-16T14:02:46Z']
  ]) {
    const body = response(time);
    const actual = normalizeGrowattCloud(body.data, device, Date.parse(expected) + 60000, zone);
    assert.equal(actual.measured_ms, Date.parse(expected), time);
  }
  const shanghai = normalizeGrowattCloud(response('2026-10-16 16:02:46').data, device, Date.parse('2026-10-16T08:05:00Z'), 'Asia/Shanghai');
  assert.equal(shanghai.measured_ms, Date.parse('2026-10-16T08:02:46Z'));
});

test('een ongeldige of toekomstige time wordt niet gemaskeerd door een geldige calendar', () => {
  const received = Date.parse('2026-10-16T14:05:00Z');
  for (const time of ['ongeldig', '2026-02-30 12:00:00', '2026-03-29 02:30:00', '2026-10-25 02:30:00']) {
    assert.throws(() => normalizeGrowattCloud(response(time).data, device, received, zone), /meettijd ontbreekt of is ongeldig/);
  }
  assert.throws(() => normalizeGrowattCloud(response('2026-10-16 16:30:00').data, device, received, zone), /toekomst/);
  const body = response();
  delete body.data.min[0].time;
  assert.equal(normalizeGrowattCloud(body.data, device, received, zone).measured_ms, body.data.min[0].calendar);
  body.data.min[0].last_update_time = '2026-10-16 16:02:46';
  assert.equal(normalizeGrowattCloud(body.data, device, received, zone).measured_ms, Date.parse('2026-10-16T14:02:46Z'));
});

test('de Growatt-meettijd is onafhankelijk van de tijdzone van het Node-proces', () => {
  const code = `import { normalizeGrowattCloud } from './src/growatt/cloud/normalize.js';
    const data = ${JSON.stringify(response().data)};
    console.log(new Date(normalizeGrowattCloud(data, ${JSON.stringify(device)}, Date.parse('2026-10-16T14:05:00Z'), 'Europe/Amsterdam').measured_ms).toISOString());`;
  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(output.trim(), '2026-10-16T14:02:46.000Z', tz);
  }
});

test('webantwoord wordt eerst goed opgeslagen en daarna ongewijzigd via API en omvormertabel als 16:02:46 getoond', async (t) => {
  const received = Date.parse('2026-10-16T14:05:00Z');
  t.mock.method(Date, 'now', () => received);
  const { settings: defaults, panels: examples } = loadConfiguration();
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, growatt: { ...defaults.growatt, production_source: 'cloud' } };
  const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];
  const panels = { ...examples, inverters: examples.inverters.map((item, index) => ({ ...item, serial: serials[index] })) };
  const db = openDatabase(':memory:'), repository = createRepository(db);
  const client = createGrowattCloudClient(growattCloudConfig(settings), 'test-token', { clock: () => received, pause: async () => {},
    onCall: repository.saveGrowattCloudCall, fetcher: async (url, options) => Response.json(response(undefined, undefined, new URLSearchParams(options.body).get('deviceSn'))) });
  for (const sn of serials) repository.saveCloudInverter(await client.read({ serial: sn, device_type: 'min' }));
  const saved = repository.currentCloudInverters();
  assert.equal(saved.length, 4);
  assert.ok(saved.every((row) => row.measured_ms === Date.parse('2026-10-16T14:02:46Z') && row.received_ms === received));
  const server = startHttpServer({ settings, panels, panelErrors: [], repository,
    weather: { status: () => ({ sunrise: '2026-10-16T06:00:00Z', sunset: '2026-10-16T17:00:00Z' }) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  const before = globalThis.document;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const current = await (await fetch(`${base}/api/v1/production/current`)).json();
    assert.equal(current.power_w, 1000);
    assert.equal(current.status, 'ok');
    assert.ok(current.inverters.every((row) => row.measured_at === '2026-10-16T14:02:46.000Z' && row.fresh));
    const day = await (await fetch(`${base}/api/v1/production/day`)).json();
    assert.deepEqual(day.points.map((point) => [point.time, point.power_w]), [['2026-10-16T14:02:46.000Z', 1000]]);
    const overview = await (await fetch(`${base}/api/v1/growatt`)).json();
    assert.deepEqual(overview.production.inverters, current.inverters);
    const history = await (await fetch(`${base}/api/v1/history?metric=inverter&source=cloud`)).json();
    assert.ok(history.rows.every((row) => row.measured_ms === Date.parse('2026-10-16T14:02:46Z')));
    const { nodes, document } = tableDocument();
    globalThis.document = document;
    renderGrowattProduction(current);
    assert.equal(nodes.get('inverters').children.length, 4);
    for (const row of nodes.get('inverters').children) {
      assert.match(row.children[5].textContent, /16:02:46$/);
      assert.match(row.children[6].textContent, /16:05:00$/);
      assert.equal(row.children[7].textContent, 'Actueel');
    }
  } finally { globalThis.document = before; await new Promise((resolve) => server.close(resolve)); db.close(); }
});

test('herstart herstelt kalenderhistorie zonder botsende meetpunten, logverlies of overschrijven van nieuwere waarden', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zonapi-time-repair-')), path = join(directory, 'data.sqlite');
  let db = openDatabase(path);
  try {
    let repository = createRepository(db);
    const morning = response('2026-10-16 10:02:46', '2026-10-16T02:02:46Z', serial, 100);
    const afternoon = response('2026-10-16 16:02:46', '2026-10-16T08:02:46Z', serial, 200);
    const first = saveLegacy(repository, morning, Date.parse('2026-10-16T08:05:00Z'));
    saveLegacy(repository, afternoon, Date.parse('2026-10-16T14:05:00Z'));
    repository.saveInverter({ ...first, frame_id: null });
    const newest = { ...normalizeGrowattCloud(afternoon.data, device, Date.parse('2026-10-16T14:06:00Z'), zone), power_w: 999 };
    repository.saveCloudInverter(newest);
    const orphan = { ...first, serial: 'INV0000002', power_w: 50 };
    repository.saveCloudInverter(orphan);
    repository.setLogging('growatt', false);
    db.close(); db = openDatabase(path);
    assert.equal(repairGrowattCloudTime(db, zone), 2);
    repository = createRepository(db);
    const history = repository.cloudInverterHistory(0, Date.parse('2026-10-17T00:00:00Z'));
    assert.deepEqual(history.filter((row) => row.serial === serial).map((row) => [new Date(row.measured_ms).toISOString(), row.power_w]), [
      ['2026-10-16T08:02:46.000Z', 100], ['2026-10-16T14:02:46.000Z', 999]
    ]);
    assert.equal(history.find((row) => row.serial === orphan.serial).measured_ms, orphan.measured_ms);
    assert.equal(repository.currentInverters()[0].measured_ms, first.measured_ms);
    assert.equal(repository.currentCloudInverters().find((row) => row.serial === serial).received_ms, newest.received_ms);
    assert.equal(repository.loggingStatus('growatt').enabled, false);
    assert.equal(repository.growattTimeline({ limit: 100, offset: 0, type: '', address: '', view: 'cloud' }).rows.length, 2);
    assert.deepEqual(JSON.parse(repository.growattCloudCall(1).response_json), morning);
    assert.equal(repairGrowattCloudTime(db, zone), 0);
    db.close(); db = openDatabase(path);
    assert.equal(repairGrowattCloudTime(db, zone), 0);
    assert.equal(createRepository(db).cloudInverterHistory(0, Date.parse('2026-10-17T00:00:00Z')).length, 3);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('tijdherstel laat afgekapt bronantwoord, afwijkende waarden en niet-passende ontvangsttijd ongemoeid', () => {
  const db = openDatabase(':memory:'), repository = createRepository(db), received = Date.parse('2026-10-16T14:05:00Z');
  try {
    saveLegacy(repository, response(), received);
    db.prepare("UPDATE growatt_cloud_calls SET response_json='{afgekapt'").run();
    assert.equal(repairGrowattCloudTime(db, zone), 0);
    db.prepare('UPDATE growatt_cloud_calls SET response_json=?').run(JSON.stringify(response(undefined, undefined, serial, 999)));
    assert.equal(repairGrowattCloudTime(db, zone), 0);
    db.prepare('UPDATE growatt_cloud_calls SET response_json=?,attempted_ms=?').run(JSON.stringify(response()), received + 60000);
    assert.equal(repairGrowattCloudTime(db, zone), 0);
    assert.equal(repository.currentCloudInverters()[0].measured_ms, Date.parse('2026-10-16T08:00:46Z'));
    assert.equal(repository.currentCloudInverters()[0].power_w, 250);
  } finally { db.close(); }
});
