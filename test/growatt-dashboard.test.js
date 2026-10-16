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
import { splitFrames, validateFrame } from '../src/growatt/frame-reader.js';
import { timeSyncCommand } from '../src/growatt/time-sync.js';
import { createClockPolicy } from '../src/growatt/clock-policy.js';
import { decodeRfConfiguration } from '../src/growatt/rf-configuration.js';
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

/** Bouwt een xx29-rapport met hetzelfde registerformaat als de ShineLanBox; input: geen; output: geldig v06-pakket. */
function rfConfigurationFixture() {
  /** Encodeert één RF-configuratieregister; input: registernummer en ASCII-waarde; output: Buffer. */
  const register = (key, value) => {
    const data = Buffer.from(value, 'ascii');
    const part = Buffer.alloc(4 + data.length);
    part.writeUInt16BE(key, 0);
    part.writeUInt16BE(data.length, 2);
    data.copy(part, 4);
    return part;
  };
  const plain = Buffer.concat([Buffer.alloc(100), register(4, '1'), register(21, '7.4.0.4'), register(30, 'GMT+8'), register(31, '2026-10-14 13:34:55')]);
  plain[3] = 6;
  plain[6] = 0x51;
  plain[7] = 0x29;
  plain[98] = 20;
  plain[99] = 0x50;
  plain.writeUInt16BE(plain.length - 6, 4);
  plain.write('LOG1234567', 8, 'ascii');
  plain.write('RFS1234567', 38, 'ascii');
  plain.write('INV1234561', 68, 'ascii');
  const encrypted = xorPayload(plain);
  const frame = Buffer.alloc(encrypted.length + 2);
  encrypted.copy(frame);
  frame.writeUInt16BE(modbusCrc(encrypted), encrypted.length);
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
    const html = await page.text();
    assert.match(html, /Berichten en logs verwijderen/);
    assert.match(html, /id="db-path"/);
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

test('API toont een mislukte Growatt-binding naast het werkelijke databasepad', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const occupied = startGrowattServer({ host: '127.0.0.1', port: 0 }, repository);
  await once(occupied, 'listening');
  const growattPort = occupied.address().port;
  const blocked = startGrowattServer({ host: '127.0.0.1', port: growattPort }, repository);
  const error = await new Promise((resolve) => blocked.once('error', resolve));
  const runtime = { server: blocked, last_error: { code: error.code, message: error.message, at: new Date().toISOString() } };
  const { settings, panels, panel_errors: panelErrors } = loadConfiguration();
  const server = startHttpServer({
    settings: { ...settings, growatt: { ...settings.growatt, host: '127.0.0.1', port: growattPort }, http: { host: '127.0.0.1', port: 0 } },
    panels, panelErrors, repository, growattRuntime: runtime,
    weather: { status: () => ({ source: 'open-meteo' }) },
    homewizard: { status: () => ({ p1: null, kwh: null }) }
  });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const growatt = await (await fetch(`${base}/api/v1/growatt`)).json();
    assert.equal(growatt.listener.listening, false);
    assert.equal(growatt.listener.last_error.code, 'EADDRINUSE');
    assert.equal(growatt.listener.port, growattPort);
    assert.equal(growatt.database_path, null);
    assert.equal(growatt.summary.frames_total, 0);
    const status = await (await fetch(`${base}/api/v1/status`)).json();
    assert.equal(status.growatt.listener.last_error.code, 'EADDRINUSE');
    assert.equal(status.growatt.database_path, null);
    const live = growattOverview(repository, { growatt: { host: '127.0.0.1', port: growattPort, expected_inverters: 4, fresh_minutes: 20 } }, panels, Date.now(), 1, { server: occupied });
    assert.equal(live.listener.listening, true);
    assert.equal(live.listener.bound_port, growattPort);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await stopGrowattServer(occupied);
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
    assert.deepEqual(log.rows.map((row) => row.status).sort(), ['reply_sent', 'announcement', 'connected'].sort());
    assert.match(log.rows.find((row) => row.status === 'reply_sent').detail, /5029 #\d+ · 11 bytes · [0-9a-f]{22}/);
    assert.equal(repository.recentGrowattProblems(10).length, 0);
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
    assert.equal(overview.frames[0].label, 'RF-configuratie');
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

test('Grott-tijdcommando is een geldig lokaal v06-18-frame met Nederlandse tijd', () => {
  const announcement = announcementFixture(0x50, 0x03, 'INV1234560');
  const command = timeSyncCommand(announcement, Date.parse('2026-10-14T10:05:07Z'));
  assert.equal(validateFrame(command).ok, true);
  assert.equal(command[6], 1);
  assert.equal(command[7], 0x18);
  const plain = xorPayload(command.subarray(0, -2));
  assert.equal(plain.subarray(8, 18).toString('ascii'), 'LOG1234567');
  assert.equal(plain.readUInt16BE(38), 31);
  assert.equal(plain.readUInt16BE(40), 19);
  assert.equal(plain.subarray(42, 61).toString('ascii'), '2026-10-14 12:05:07');
  assert.equal(timeSyncCommand(announcementFixture(0x51, 0x29, 'INV1234561'), Date.now()), null);
});

test('RF-configuratie toont meetinterval, firmware en apparaatklok uit xx29', () => {
  const frame = rfConfigurationFixture();
  const config = decodeRfConfiguration(frame);
  assert.equal(config.address, '51');
  assert.equal(config.rf_serial, 'RFS1234567');
  assert.equal(config.update_interval_minutes, 1);
  assert.equal(config.firmware, '7.4.0.4');
  assert.equal(config.timezone, 'GMT+8');
  assert.equal(config.device_time, '2026-10-14 13:34:55');
  assert.equal(config.registers[31], '2026-10-14 13:34:55');
  const db = openDatabase(':memory:');
  try {
    const repository = createRepository(db);
    const id = repository.saveFrame(Date.now(), 'local', 6, '5129', 'announcement', frame);
    assert.deepEqual(growattFrameDetail(repository, id).rf_configuration, config);
  } finally { db.close(); }
});

test('kloksynchronisatie herhaalt alleen bij ontbrekende xx04-metingen', () => {
  const state = createClockPolicy(4, 10);
  const start = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(state.shouldSync(start), true);
  assert.equal(state.shouldSync(start + 9 * 60000), false);
  state.receivedMeasurement(0x50);
  state.receivedMeasurement(0x51);
  state.receivedMeasurement(0x52);
  assert.equal(state.shouldSync(start + 10 * 60000), true);
  state.receivedMeasurement(0x53);
  assert.equal(state.shouldSync(start + 30 * 60000), false);
});

test('03-aanmeldingen van vier adressen krijgen ACK en tijdopdracht na de eerste ACK', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const server = startGrowattServer({ host: '127.0.0.1', port: 0 }, repository);
  await once(server, 'listening');
  const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
  await once(socket, 'connect');
  socket.setTimeout(2000, () => socket.destroy(new Error('Geen lokaal antwoord')));
  try {
    const replies = [];
    let rest = Buffer.alloc(0);
    const firstTwo = new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.on('data', (chunk) => {
        const split = splitFrames(rest, chunk);
        rest = split.remainder;
        replies.push(...split.frames);
        if (replies.length >= 2) resolve();
      });
    });
    socket.write(announcementFixture(0x50, 0x03, 'INV1234560'));
    await firstTwo;
    assert.deepEqual(replies.map((frame) => frame[7]), [3, 0x18]);
    assert.ok(replies.every((frame) => validateFrame(frame).ok));
    assert.equal(repository.growattTimeline({ limit: 20, offset: 0, type: '', address: '', view: 'all' }).rows.filter((row) => row.status === 'time_sync_sent').length, 1);
    assert.equal(repository.recentGrowattProblems(10).length, 0);
    const third = once(socket, 'data');
    socket.write(announcementFixture(0x51, 0x03, 'INV1234561'));
    await third;
    assert.deepEqual(replies.map((frame) => frame[7]), [3, 0x18, 3]);
    const next = new Promise((resolve) => {
      const check = () => {
        if (replies.length >= 5) { socket.off('data', check); resolve(); }
      };
      socket.on('data', check);
    });
    socket.write(Buffer.concat([
      announcementFixture(0x52, 0x03, 'INV1234562'),
      announcementFixture(0x53, 0x03, 'INV1234563')
    ]));
    await next;
    assert.deepEqual(replies.map((frame) => frame[7]), [3, 0x18, 3, 3, 3]);
    assert.ok(replies.every((frame) => validateFrame(frame).ok));
  } finally {
    socket.destroy();
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
    assert.equal(repository.databasePath(), path);
    assert.equal(repository.frameStatus()[0].count, 1);
    repository.saveGrowattEvent(2, 'local', 'socket_error', 'test');
    assert.equal(repository.recentGrowattProblems(1)[0].detail, 'test');
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('historische omvormermetingen blijven bestaan na een migratie en het wissen van logs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zonapi-growatt-clear-'));
  const path = join(directory, 'data.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE growatt_frames (
      id INTEGER PRIMARY KEY, received_ms INTEGER NOT NULL, peer TEXT NOT NULL,
      protocol INTEGER, record_type TEXT, status TEXT NOT NULL, raw BLOB NOT NULL
    );
    CREATE TABLE inverter_measurements (
      serial TEXT NOT NULL, measured_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      power_w REAL NOT NULL, energy_today_kwh REAL, energy_total_kwh REAL,
      frame_id INTEGER NOT NULL REFERENCES growatt_frames(id), PRIMARY KEY(serial, measured_ms)
    );`);
    const id = Number(old.prepare("INSERT INTO growatt_frames(received_ms,peer,protocol,record_type,status,raw) VALUES(1,'local',6,'5004','decoded',x'00')").run().lastInsertRowid);
    old.prepare('INSERT INTO inverter_measurements VALUES (?,?,?,?,?,?,?)').run('INV1234560', 1, 1, 1200, 2, 200, id);
    old.close();
    const db = openDatabase(path);
    const repository = createRepository(db);
    repository.saveGrowattEvent(2, 'local', 'socket_error', 'vorige sessie');
    assert.equal(db.prepare('PRAGMA table_info(inverter_measurements)').all().find((column) => column.name === 'frame_id').notnull, 0);
    assert.deepEqual(repository.clearGrowattDiagnostics(), { frames_deleted: 1, events_deleted: 1, cloud_calls_deleted: 0 });
    assert.equal(repository.recentGrowattFrames(10).length, 0);
    assert.equal(repository.growattTimeline({ limit: 10, offset: 0, type: '', address: '', view: 'all' }).rows.length, 0);
    assert.deepEqual(repository.history('inverter', 0, 10, 10).map((row) => ({ power_w: row.power_w, frame_id: row.frame_id })), [{ power_w: 1200, frame_id: null }]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
    const reopened = openDatabase(path);
    assert.equal(createRepository(reopened).history('inverter', 0, 10, 10)[0].power_w, 1200);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
