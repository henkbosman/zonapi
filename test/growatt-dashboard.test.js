import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { loadConfiguration } from '../src/config/load.js';
import { startGrowattServer, stopGrowattServer } from '../src/growatt/tcp-listener.js';
import { decodeAnnouncement } from '../src/growatt/announcement.js';
import { xorPayload } from '../src/growatt/mask.js';
import { modbusCrc } from '../src/growatt/crc.js';
import { growattOverview, growattFrameDetail } from '../src/api/growatt-diagnostics.js';
import { startHttpServer } from '../src/api/http-server.js';

/** Bouwt een eigen v06-testaanmelding zonder apparaatgegevens; input: adres, soort en serienummer; output: geldig frame. */
function announcementFixture(address, kind, serial) {
  const size = kind === 0x03 ? 585 : 245;
  const plain = Buffer.alloc(size - 2);
  plain[3] = 6;
  plain.writeUInt16BE(size - 8, 4);
  plain[6] = address;
  plain[7] = kind;
  plain.write('LOG1234567', 8, 'ascii');
  plain.write(serial, kind === 0x03 ? 38 : 68, 'ascii');
  const masked = xorPayload(plain);
  const frame = Buffer.alloc(size);
  masked.copy(frame);
  frame.writeUInt16BE(modbusCrc(masked), size - 2);
  return frame;
}

test('Growatt-pagina en API tonen pakketmetadata, ruwe inhoud en ontvangerfouten', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const received = Date.now();
  const raw = Buffer.from('0001000200040016abcd', 'hex');
  const id = repository.saveFrame(received, '127.0.0.1', 2, '0016', 'control', raw);
  const badId = repository.saveFrame(received + 1, '127.0.0.1', 6, '5104', 'bad_crc', raw);
  repository.saveGrowattEvent(received + 2, '127.0.0.1', 'socket_error', 'testfout');
  const { settings, panels, panel_errors: panelErrors } = loadConfiguration();
  const server = startHttpServer({
    settings: { ...settings, http: { host: '127.0.0.1', port: 0 } }, panels, panelErrors, repository,
    weather: { status: () => ({ source: 'open-meteo', used_requests: 0, max_requests: 12, location_configured: false }) },
    homewizard: { status: () => ({ p1: null, kwh: null }) }
  });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${base}/growatt`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Berichten en verbindingen/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const dashboard = await (await fetch(`${base}/dashboard`)).text();
    assert.match(dashboard, /href="\/growatt"/);
    const overview = await (await fetch(`${base}/api/v1/growatt?limit=1`)).json();
    assert.equal(overview.summary.frames_total, 2);
    assert.equal(overview.frames.length, 1);
    assert.equal(overview.frames[0].status, 'bad_crc');
    assert.equal(overview.frames[0].size_bytes, raw.length);
    assert.equal(Object.hasOwn(overview.frames[0], 'raw_hex'), false);
    assert.deepEqual(overview.problems.map((item) => item.status), ['socket_error', 'bad_crc']);
    assert.equal(overview.problems[1].frame_id, badId);
    const timeline = await (await fetch(`${base}/api/v1/growatt/timeline?limit=1`)).json();
    assert.equal(timeline.rows.length, 1);
    assert.equal(timeline.rows[0].status, 'socket_error');
    assert.equal(timeline.has_more, true);
    const older = await (await fetch(`${base}/api/v1/growatt/timeline?limit=1&offset=1`)).json();
    assert.equal(older.rows[0].status, 'bad_crc');
    assert.equal(older.rows[0].source, 'packet');
    const detail = await (await fetch(`${base}/api/v1/growatt/frames/${id}`)).json();
    assert.equal(detail.raw_hex, raw.toString('hex'));
    assert.equal(detail.record_type, '0016');
    assert.equal(detail.measurement, null);
    assert.equal(detail.announcement, null);
    assert.equal((await fetch(`${base}/api/v1/growatt/frames/999`)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/growatt?limit=101`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('live tijdlijn toont oudere xx04-metingen naast verbindingsfouten en vernieuwt zonder procesherstart', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const now = Date.now();
  const { settings, panels, panel_errors: panelErrors } = loadConfiguration();
  const server = startHttpServer({
    settings: { ...settings, http: { host: '127.0.0.1', port: 0 } }, panels, panelErrors, repository,
    weather: { status: () => ({ source: 'open-meteo', location_configured: false }) },
    homewizard: { status: () => ({ p1: null, kwh: null }) }
  });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const first = await (await fetch(`${base}/api/v1/growatt`)).json();
    assert.equal(first.summary.frames_total, 0);
    const measurementId = repository.saveFrame(now - 3000, 'local', 6, '5004', 'decoded:T06NNNNX:clock_fallback', Buffer.alloc(585));
    repository.saveFrame(now - 3500, 'local', 6, '5104', 'decoded:T06NNNNX', Buffer.alloc(585));
    for (let i = 0; i < 120; i++) repository.saveFrame(now - 2000 + i, 'local', 6, '5103', 'announcement', Buffer.alloc(20));
    repository.saveGrowattEvent(now, 'local:1029', 'timeout', '120 s');
    const refreshed = await fetch(`${base}/api/v1/growatt?limit=1`);
    assert.equal(refreshed.headers.get('cache-control'), 'no-store');
    assert.equal((await refreshed.json()).summary.frames_total, 122);
    const all = await (await fetch(`${base}/api/v1/growatt/timeline?limit=3`)).json();
    assert.deepEqual(all.rows.map((row) => row.source), ['event', 'packet', 'packet']);
    const everyMeasurement = await (await fetch(`${base}/api/v1/growatt/timeline?type=xx04`)).json();
    assert.deepEqual(everyMeasurement.rows.map((row) => row.record_type), ['5004', '5104']);
    const filtered = await (await fetch(`${base}/api/v1/growatt/timeline?type=xx04&address=50`)).json();
    assert.equal(filtered.rows.length, 1);
    assert.equal(filtered.rows[0].id, measurementId);
    assert.equal(filtered.rows[0].record_type, '5004');
    const errors = await (await fetch(`${base}/api/v1/growatt/timeline?view=errors`)).json();
    assert.deepEqual(errors.rows.map((row) => row.status), ['timeout']);
    const eventsAndType = await (await fetch(`${base}/api/v1/growatt/timeline?view=events&type=xx04`)).json();
    assert.deepEqual(eventsAndType.rows, []);
    assert.equal((await fetch(`${base}/api/v1/growatt/timeline?type=xxzz`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('TCP-verbinding houdt ShineLanBox meetinterval aan en slaat verbindingsinformatie op', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const server = startGrowattServer({ host: '127.0.0.1', port: 0 }, repository);
  await once(server, 'listening');
  const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
  const [accepted] = await once(server, 'connection');
  await once(socket, 'connect');
  try {
    assert.equal(accepted.timeout, 30 * 60000);
    socket.write(announcementFixture(0x50, 0x29, 'INV1234560'));
    await once(socket, 'data');
    const log = repository.growattTimeline({ limit: 10, offset: 0, type: '', address: '', view: 'all' });
    assert.deepEqual(log.rows.map((row) => row.source), ['packet', 'event']);
    assert.equal(log.rows[1].status, 'connected');
  } finally {
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('dienst kan met een open ShineLanBox-verbinding direct en zonder databasefout stoppen', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const server = startGrowattServer({ host: '127.0.0.1', port: 0 }, repository);
  await once(server, 'listening');
  const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
  await once(socket, 'connect');
  try {
    await stopGrowattServer(server);
    assert.equal(server.listening, false);
    assert.equal(repository.growattTimeline({ limit: 10, offset: 0, type: '', address: '', view: 'all' }).rows[0].status, 'connected');
  } finally {
    socket.destroy();
    db.close();
  }
});

test('vier ShineLanBox-adressen tonen eerdere 03/29-aanmeldingen en serienummers', () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  try {
    for (let i = 0; i < 4; i++) {
      const address = 0x50 + i;
      const serial = `INV123456${i}`;
      for (const kind of [0x03, 0x29]) {
        const frame = announcementFixture(address, kind, serial);
        const decoded = decodeAnnouncement(frame);
        assert.equal(decoded.inverter_serial, serial);
        assert.equal(decoded.datalogger_serial, 'LOG1234567');
        const id = repository.saveFrame(Date.now() + i, '127.0.0.1', 6, frame.subarray(6, 8).toString('hex'), 'control', frame);
        assert.equal(repository.growattFrame(id).raw.length, frame.length);
      }
    }
    const { settings, panels } = loadConfiguration();
    const overview = growattOverview(repository, settings, panels, Date.now(), 50);
    assert.deepEqual(overview.announcements.map((item) => item.address), ['50', '51', '52', '53']);
    assert.equal(overview.announcements[0].inverter_serial, 'INV1234560');
    assert.equal(overview.frames[0].label, 'Aanmelding');
    assert.equal(overview.production.active_inverters, 0);
    assert.equal(overview.problems.length, 0);
    assert.equal(growattFrameDetail(repository, overview.announcements[0].frame_id).announcement.inverter_serial, 'INV1234560');
  } finally {
    db.close();
  }
});

test('een ongeldig TCP-pakket verschijnt als Growatt-fout', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const server = startGrowattServer({ host: '127.0.0.1', port: 0 }, repository);
  await once(server, 'listening');
  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    socket.write(Buffer.from('0001000200010016', 'hex'));
    await closed;
    const [error] = repository.recentGrowattProblems(1);
    assert.equal(error.status, 'frame_error');
    assert.match(error.detail, /framelengte/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('een onbekend databericht wordt zichtbaar als unknown_layout', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const server = startGrowattServer({ host: '127.0.0.1', port: 0 }, repository);
  await once(server, 'listening');
  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
    await once(socket, 'connect');
    const reply = once(socket, 'data');
    socket.write(Buffer.from('00010002000453040000', 'hex'));
    await reply;
    assert.equal(repository.recentGrowattProblems(1)[0].status, 'unknown_layout');
    socket.destroy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('de TCP-ontvanger registreert een 29-bericht als aanmelding', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const server = startGrowattServer({ host: '127.0.0.1', port: 0 }, repository);
  await once(server, 'listening');
  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
    await once(socket, 'connect');
    const reply = once(socket, 'data');
    socket.write(announcementFixture(0x52, 0x29, 'INV1234562'));
    await reply;
    assert.equal(repository.frameStatus()[0].status, 'announcement');
    assert.equal(repository.latestGrowattAnnouncements().length, 1);
    socket.destroy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('bestaande pakketgeschiedenis blijft behouden bij de database-uitbreiding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zonapi-growatt-'));
  const path = join(directory, 'history.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE growatt_frames (
      id INTEGER PRIMARY KEY, received_ms INTEGER NOT NULL, peer TEXT NOT NULL,
      protocol INTEGER, record_type TEXT, status TEXT NOT NULL, raw BLOB NOT NULL
    )`);
    old.prepare('INSERT INTO growatt_frames(received_ms,peer,status,raw) VALUES(?,?,?,?)').run(1, 'local', 'control', Buffer.from([1, 2]));
    old.close();
    const upgraded = openDatabase(path);
    const repository = createRepository(upgraded);
    assert.equal(repository.frameStatus()[0].count, 1);
    repository.saveGrowattEvent(2, 'local', 'socket_error', 'test');
    assert.equal(repository.recentGrowattProblems(1)[0].detail, 'test');
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
