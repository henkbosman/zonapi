import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { cycleEnergyPoints } from '../src/appliances/cycle-energy.js';
import { applianceCycleResponse } from '../src/api/appliance-cycles.js';
import { startHttpServer } from '../src/api/http-server.js';

const base = Date.parse('2026-10-20T12:00:00Z'), minute = 60000;

/** Bouwt echte historische net-/omvormeropslag; input: testcontext en optioneel databasepad; output: bron- en grafiekhelpers. */
function fixture(t, path = ':memory:') {
  const { settings } = loadConfiguration();
  settings.growatt = { ...settings.growatt, expected_inverters: 2, production_source: 'shinelink' };
  settings.advice.baseload_w = 0;
  const db = openDatabase(path), repository = createRepository(db);
  const serials = ['PRIVATE-INV-A', 'PRIVATE-INV-B'];
  const f = { settings, db, repository, serials };
  f.pv = (power, at = base, { source = 'shinelink', ids = serials, received = at } = {}) => {
    for (const serial of ids) {
      const row = { serial, measured_ms: at, received_ms: received, power_w: power / ids.length,
        energy_today_kwh: 1, energy_total_kwh: 10, frame_id: null };
      if (source === 'cloud') repository.saveCloudInverter(row); else repository.saveInverter(row);
    }
  };
  f.net = (power, at = base, device = 'p1', received = at) => repository.saveMeter({ device, measured_ms: at, received_ms: received,
    net_power_w: power, import_kwh: 1, export_kwh: 1 });
  f.split = (powers = [1000], at = base, now = at + 3600000) => cycleEnergyPoints(powers.map((power_w, index) => ({ measured_ms: at + index * 1000, power_w })), repository, settings, now, serials);
  t.after(() => { try { db.close(); } catch {} });
  return f;
}

test('zon en net worden naar huisverbruik verdeeld; import, export, nulopwek en balans blijven behouden', (t) => {
  const f = fixture(t);
  for (const [index, [pv, net, power, solar, grid]] of [
    [600, 600, 1000, 500, 500], [1500, -400, 1000, 1000, 0], [0, 1500, 1000, 0, 1000],
    [1000, 0, 900, 900, 0], [800, 1200, 500, 200, 300]
  ].entries()) {
    const at = base + index * 10 * minute;
    f.pv(pv, at); f.net(net, at);
    const [point] = f.split([power], at);
    assert.equal(point.solar_power_w, solar);
    assert.equal(point.grid_power_w, grid);
    assert.equal(point.solar_power_w + point.grid_power_w, power);
  }
});

test('gelijktijdige apparaten krijgen dezelfde huisverhouding zonder dezelfde zonne-energie dubbel te gebruiken', (t) => {
  const f = fixture(t); f.pv(800); f.net(1200);
  const washer = f.split([1000])[0], dryer = f.split([500])[0];
  assert.equal(washer.solar_power_w, 400); assert.equal(dryer.solar_power_w, 200);
  assert.ok(washer.solar_power_w + dryer.solar_power_w <= 800);
  assert.equal(washer.grid_power_w + dryer.grid_power_w, 900);
});

test('P1 en kWh zijn één netpunt; ingestelde voorkeur en terugval bij verouderde P1 worden gevolgd', (t) => {
  const f = fixture(t); f.pv(1000); f.net(1000); f.net(0, base, 'kwh');
  assert.equal(f.split()[0].solar_power_w, 500);
  f.settings.homewizard.net_meter_priority = ['kwh', 'p1'];
  assert.equal(f.split()[0].solar_power_w, 1000);
  f.settings.homewizard.net_meter_priority = ['p1', 'kwh'];
  f.net(0, base + 121000, 'kwh');
  assert.equal(f.split([1000], base + 121000)[0].solar_power_w, 1000);
});

test('ontbrekende, toekomstige, onvolledige of tegenstrijdige metingen blijven onbekend; een echte programmapauze blijft nul', (t) => {
  const f = fixture(t);
  assert.equal(f.split()[0].solar_power_w, null);
  f.net(1000); assert.equal(f.split()[0].grid_power_w, null);
  f.pv(1000, base + 1000); assert.equal(f.split()[0].solar_power_w, null);
  f.pv(500, base, { ids: [f.serials[0]] });
  assert.equal(f.split()[0].solar_power_w, null);
  f.pv(1000, base); f.net(-1500, base, 'p1', base + 1);
  assert.equal(f.split()[0].solar_power_w, null);
  f.net(-500, base, 'p1', base + 2); // Huisverbruik 500W kan geen apparaat van 1000W bevatten.
  assert.equal(f.split()[0].grid_power_w, null);
  assert.deepEqual(f.split([0])[0], { measured_ms: base, power_w: 0, solar_power_w: 0, grid_power_w: 0 });
});

test('bronuitval geeft gaten en nieuwe metingen herstellen de verdeling; toekomstige ontvangst wordt niet gebruikt', (t) => {
  const f = fixture(t); f.pv(1000); f.net(1000);
  assert.equal(f.split()[0].solar_power_w, 500);
  assert.equal(f.split([1000], base + 120001)[0].solar_power_w, null);
  f.net(1000, base + 120001);
  assert.equal(f.split([1000], base + 120001)[0].solar_power_w, 500);
  const future = base + 2000;
  f.pv(1000, future, { received: future + 60000 });
  f.net(1000, future, 'p1', future + 60000);
  const rows = cycleEnergyPoints([{ measured_ms: future, power_w: 1000 }], f.repository, f.settings, future, f.serials);
  assert.equal(rows[0].solar_power_w, 500); // De eerdere geldige metingen blijven leidend.
});

test('cloudmetingen hebben de bestaande versheidsmarge, en lokale/cloudbronnen worden niet bij elkaar opgeteld', (t) => {
  const f = fixture(t); f.settings.growatt.production_source = 'cloud';
  f.pv(1000, base, { source: 'cloud' }); f.pv(9000); f.net(1000, base + 19 * minute);
  assert.equal(f.split([1000], base + 19 * minute)[0].solar_power_w, 500);
  f.net(1000, base + 20 * minute + 1);
  assert.equal(f.split([1000], base + 20 * minute + 1)[0].solar_power_w, null);
  f.settings.growatt.production_source = 'auto'; f.net(1000);
  assert.equal(f.split([1000])[0].solar_power_w, 900); // Verse lokale bron heeft voorrang.
});

test('een gedeeltelijke nieuwe omvormerronde vormt geen nieuw totaal en onbekende omvormers tellen niet mee', (t) => {
  const f = fixture(t); f.pv(1000); f.net(1000);
  f.pv(5000, base + 1000, { ids: [f.serials[0]] });
  f.pv(9000, base + 1000, { ids: ['UNMAPPED'] });
  assert.equal(f.split([1000], base + 2000)[0].solar_power_w, 500);
});

test('cycli over Nederlandse middernacht en de herhaalde wintertijd blijven aan hun eigen echte meettijd gekoppeld', (t) => {
  const f = fixture(t);
  for (const at of [Date.parse('2026-10-20T21:59:30Z'), Date.parse('2026-10-25T00:30:00Z'), Date.parse('2026-10-25T01:30:00Z')]) {
    f.pv(1000, at); f.net(1000, at);
    const time = at + 60000;
    assert.equal(f.split([1000], time)[0].solar_power_w, 500);
  }
});

test('beide cyclus-API’s geven historische bronlijnen veilig door, ook na herstart en logbeheer', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'zonapi-cycle-energy-'));
  const path = join(directory, 'test.sqlite');
  const f = fixture(t, path), now = base + 60000;
  t.mock.method(Date, 'now', () => now);
  const profile = { id: 'machine', name: 'Machine', homewizard: { host: '192.168.2.222' }, steps: [{ duration_minutes: 60, power_w: 1000 }] };
  writeFileSync(join(directory, 'machine.json'), JSON.stringify(profile));
  const addRun = (start, powers) => {
    const id = f.db.prepare(`INSERT INTO appliance_cycles(appliance_id,config_key,started_ms,ended_ms,state,complete,gap_ms,last_ms,sample_count)
      VALUES(?,'PRIVATE-CONFIG',?,?,'completed',1,120000,?,?)`).run(profile.id, start, start + 30000, start + 30000, powers.length).lastInsertRowid;
    for (const [index, power] of powers.entries()) f.db.prepare('INSERT INTO appliance_cycle_samples VALUES(?,?,?)').run(id, start + index * 30000, power);
  };
  addRun(base - 86400000, [800, 400]); addRun(base, [1000, 500]);
  f.pv(600); f.net(1400);
  f.pv(0, base - 86400000); f.net(1000, base - 86400000);
  f.repository.clearHomeWizardDiagnostics(); f.repository.clearGrowattDiagnostics();
  f.db.close();
  const db = openDatabase(path), repository = createRepository(db);
  const settings = { ...f.settings, http: { host: '127.0.0.1', port: 0 } };
  const panels = { inverters: f.serials.map((serial) => ({ id: serial, serial, ac_limit_w: 2000 })), groups: [] };
  const server = startHttpServer({ settings, panels, panelErrors: [], repository, profilesDirectory: directory,
    weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  try {
    const get = async (route) => (await fetch(`http://127.0.0.1:${server.address().port}${route}`)).json();
    const internal = (await get('/intern/api/v1/appliances/cycles')).appliances[0];
    const publicData = (await get('/api/v1/dashboard')).cycles.appliances[0];
    assert.deepEqual(publicData.current.points, internal.current.points);
    assert.equal(publicData.current.points[0].solar_power_w, 300);
    assert.equal(publicData.current.points[1].grid_power_w, 350);
    assert.equal(publicData.previous.points[0].grid_power_w, 800);
    assert.equal(publicData.previous.points[0].solar_power_w, 0);
    const text = JSON.stringify(publicData);
    for (const value of ['PRIVATE-INV', 'PRIVATE-CONFIG', '192.168.2.222']) assert.ok(!text.includes(value));
    assert.equal(applianceCycleResponse(profile, repository, settings, now, panels).current.points[0].solar_power_w, 300);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
