import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { loadConfiguration } from '../src/config/load.js';
import { startHttpServer } from '../src/api/http-server.js';
import { databaseCatalog, databaseRows } from '../src/api/database-browser.js';

/** Opent een database met uiteenlopende celtypes en gelijke sorteerwaarden; input: testcontext; output: SQLite. */
function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE browser_test(id INTEGER PRIMARY KEY, name TEXT, power REAL, raw BLOB, large INTEGER, doubled REAL GENERATED ALWAYS AS (power*2) VIRTUAL)');
  const insert = db.prepare('INSERT INTO browser_test(id,name,power,raw,large) VALUES(?,?,?,?,?)');
  for (let id = 1; id <= 123; id++) insert.run(id, id % 2 ? 'Was 100%_machine' : 'Droger', id === 1 ? 100 : 9, Buffer.from([0, 255, id]), 9007199254740993n);
  insert.run(124, null, null, null, null);
  return db;
}

function rows(db, query = {}) { return databaseRows(db, new URLSearchParams({ table: 'browser_test', page_size: '10', ...query })); }

test('databasecatalogus en rijen behouden alle kolommen, BLOBs en grote integers zonder opslagwijziging', (t) => {
  const db = fixture(t), changes = db.prepare('SELECT total_changes() AS count').get().count;
  const catalog = databaseCatalog(db), table = catalog.tables.find((item) => item.name === 'browser_test');
  assert.deepEqual(table.columns.map((column) => column.name), ['id', 'name', 'power', 'raw', 'large', 'doubled']);
  assert.equal(catalog.tables.some((item) => item.name.startsWith('sqlite_')), false);
  const result = rows(db);
  assert.equal(result.total_rows, 124); assert.equal(result.total_pages, 13);
  assert.deepEqual(result.rows[0], [1, 'Was 100%_machine', 100, '0x00FF01', '9007199254740993', 200]);
  const all = [];
  for (let page = 1; page <= result.total_pages; page++) all.push(...rows(db, { page: String(page), sort: 'power' }).rows.map((row) => row[0]));
  assert.equal(all.length, 124); assert.equal(new Set(all).size, 124);
  assert.equal(all[0], 124); assert.equal(all.at(-1), 1);
  assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
});

test('sortering gebruikt numerieke waarden, filters gelden samen en laatste pagina wordt begrensd', (t) => {
  const db = fixture(t);
  assert.equal(rows(db, { sort: 'power', direction: 'desc' }).rows[0][2], 100);
  const filter = (filters, extra = {}) => rows(db, { filters: JSON.stringify(filters), ...extra });
  const result = filter([{ column: 'name', value: 'WAS 100%_' }, { column: 'power', value: '9' }], { page_size: '25', page: '999999' });
  assert.equal(result.filtered_rows, 61); assert.equal(result.total_rows, 124);
  assert.equal(result.page, 3); assert.equal(result.rows.length, 11);
  assert.equal(filter([{ column: 'raw', value: '0x00ff01' }]).rows[0][0], 1);
  assert.equal(filter([{ column: 'large', value: '9007199254740993' }]).filtered_rows, 123);
  assert.deepEqual(filter([{ column: 'name', value: 'NULL' }]).rows, [[124, null, null, null, null, null]]);
  const empty = filter([{ column: 'name', value: 'bestaat niet' }]);
  assert.equal(empty.filtered_rows, 0); assert.equal(empty.page, 1); assert.equal(empty.total_pages, 1); assert.deepEqual(empty.rows, []);
});

test('filters blijven letterlijke tekst en onbekende identifiers of queryopdrachten worden geweigerd', (t) => {
  const db = fixture(t);
  for (const value of ["' OR 1=1 --", '%', '_', '\\']) {
    const result = rows(db, { filters: JSON.stringify([{ column: 'name', value }]) });
    assert.equal(result.filtered_rows, ['%', '_'].includes(value) ? 62 : 0);
  }
  for (const query of [
    { table: 'browser_test; DROP TABLE forecast' }, { table: 'sqlite_schema' }, { sort: 'id;DELETE FROM forecast' },
    { direction: 'desc;DROP TABLE forecast' }, { page_size: '100000' }, { page_size: '0' }, { page_size: 'NaN' },
    { page: '-1' }, { page: '1.5' }, { page: '9007199254740992' }, { filters: '{' }, { filters: '{}' },
    { filters: '[{"column":"name OR 1=1","value":"x"}]' }, { filters: '[{"column":"name","value":5}]' },
    { filters: '[{"column":"name","value":"x"},{"column":"name","value":"y"}]' }
  ]) assert.throws(() => rows(db, query), Error, JSON.stringify(query));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM browser_test').get().count, 124);
});

test('gequote tabel- en kolomnamen en samengestelde sleutels zonder rowid blijven toegankelijk', (t) => {
  const db = fixture(t);
  db.exec('CREATE TABLE "tabel \"\" speciaal"("kolom \"\" naam" TEXT, "order" INTEGER, PRIMARY KEY("kolom \"\" naam","order")) WITHOUT ROWID');
  db.prepare('INSERT INTO "tabel \"\" speciaal" VALUES(?,?)').run('test', 12);
  const result = rows(db, { table: 'tabel " speciaal', sort: 'order', filters: JSON.stringify([{ column: 'kolom " naam', value: 'test' }]) });
  assert.deepEqual(result.rows, [['test', 12]]);
});

test('Database-pagina en assets zijn bereikbaar; database-API laat alle pagina’s lezen en weigert schrijfmethoden', async (t) => {
  const db = fixture(t), repository = createRepository(db);
  const { settings, panels, panel_errors: panelErrors } = loadConfiguration();
  const server = startHttpServer({ settings: { ...settings, http: { host: '127.0.0.1', port: 0 } }, panels, panelErrors, repository,
    weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening'); t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/intern/database', '/intern/database.js', '/intern/database.css']) {
    const response = await fetch(base + path); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  }
  for (const path of ['/intern/growatt', '/intern/weather', '/intern/homewizard']) assert.match(await (await fetch(base + path)).text(), /href="\/intern\/database">Database/);
  const html = await (await fetch(`${base}/intern/database`)).text();
  assert.match(html, /<dialog/); assert.match(html, /Records per pagina/);
  assert.doesNotMatch(await (await fetch(`${base}/dashboard`)).text(), /id="health"/);
  const growatt = await (await fetch(`${base}/intern/growatt`)).text();
  assert.doesNotMatch(growatt, /De ronde start om de vijf minuten|cloud-measurement-times/);
  assert.equal((await (await fetch(`${base}/intern/api/v1/database/tables`)).json()).tables.some((table) => table.name === 'browser_test'), true);
  const page = await (await fetch(`${base}/intern/api/v1/database/rows?table=browser_test&page_size=100&page=2`)).json();
  assert.equal(page.rows.length, 24); assert.equal(page.rows.at(-1)[0], 124);
  assert.equal((await fetch(`${base}/intern/api/v1/database/rows?table=missing`)).status, 400);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(`${base}/intern/api/v1/database/rows?table=browser_test`, { method })).status, 405);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM browser_test').get().count, 124);
});
