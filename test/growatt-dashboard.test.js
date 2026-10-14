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
import { startGrowattServer } from '../src/growatt/tcp-listener.js';
import { startHttpServer } from '../src/api/http-server.js';

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
    assert.match(await page.text(), /Laatste pakketten/);
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
    const detail = await (await fetch(`${base}/api/v1/growatt/frames/${id}`)).json();
    assert.equal(detail.raw_hex, raw.toString('hex'));
    assert.equal(detail.record_type, '0016');
    assert.equal(detail.measurement, null);
    assert.equal((await fetch(`${base}/api/v1/growatt/frames/999`)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/growatt?limit=101`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
