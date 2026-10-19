import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProfile, loadProfiles } from '../src/appliances/load-profiles.js';
import { appliancePrograms, programEnvelope } from '../src/appliances/programs.js';
import { adviseAppliance } from '../src/appliances/program-advice.js';
import { dailyAdvice } from '../src/appliances/daily-advice.js';
import { createActiveDemand } from '../src/appliances/active-demand.js';
import { socketConfig, socketConfigKey } from '../src/appliances/socket-config.js';
import { createSocketPoller } from '../src/homewizard/socket-poller.js';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { startHttpServer } from '../src/api/http-server.js';
import { renderDailyAdvice } from '../public/dashboard-daily-advice.js';

const minute = 60000, quarter = 15 * minute, now = Date.parse('2026-10-19T08:00:00Z');
const at = (day, time) => Date.parse(`2026-10-${day}T${time}:00Z`);
const curve = (time) => new Date(time).getUTCHours() >= 9 ? 1800 : new Date(time).getUTCMinutes() >= 30 ? 1000 : 800;
const device = () => ({ id: 'vaatwasser', name: 'Vaatwasser', min_solar_share: 1, programs: [
  { id: 'eco', name: 'Eco', steps: [{ duration_minutes: 45, power_w: 700 }] },
  { id: 'snel', name: 'Snel', steps: [{ duration_minutes: 15, power_w: 1500 }] }
] });

/** Bouwt een direct controleerbare kwartierprognose voor drie dagen; input: vermogensfunctie; output: context, opslaginterface en weer. */
function fixture(power = curve) {
  const weather = [];
  for (let start = now - 2 * 3600000; start < now + 75 * 3600000; start += quarter) weather.push({
    start_ms: start, end_ms: start + quarter, fetched_ms: now, power_w: power(start) });
  const settings = { advice: { search_hours: 4, start_step_minutes: 5, min_solar_share: 1, reserve_w: 100 },
    weather: { forecast_days: 3, stale_after_hours: 4 }, homewizard: { poll_seconds: 30 } };
  const repository = { getSun: (day) => ({ sunrise_ms: Date.parse(day + 'T08:00:00Z'), sunset_ms: Date.parse(day + 'T12:00:00Z') }) };
  const context = { now, settings, panels: {}, panelErrors: [], latitude: 52, longitude: 5,
    baseload: { power_w: 100 }, pvModel: { estimate: (row) => ({ power_w: row.power_w }) } };
  return { weather, settings, repository, context };
}

test('programmanamen en eigen stappen zijn voldoende; ids en programmaduur worden afgeleid en legacy steps blijven geldig', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-program-config-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const appliance = device(); delete appliance.programs[0].id;
  appliance.programs[0].name = 'Éco 40 °C'; appliance.min_solar_share = null;
  assert.deepEqual(validateProfile(appliance), []);
  writeFileSync(join(folder, 'modern.json'), JSON.stringify(appliance));
  const legacy = { id: 'wasmachine', name: 'Wasmachine', steps: [{ duration_minutes: 90, power_w: 1000 }] };
  writeFileSync(join(folder, 'legacy.json'), JSON.stringify(legacy));
  const loaded = loadProfiles(folder);
  assert.deepEqual(loaded.errors, []);
  const modern = loaded.profiles.get(appliance.id);
  assert.equal(modern.programs[0].id, 'eco-40-c'); assert.equal(modern.programs[0].name, 'Éco 40 °C');
  assert.equal(modern.programs[0].duration_minutes, 45); assert.equal(modern.duration_minutes, 45);
  const old = loaded.profiles.get(legacy.id);
  assert.equal(old.programs[0].id, 'standaard'); assert.equal(old.programs[0].name, 'Standaard');
  assert.equal(old.programs[0].duration_minutes, 90); assert.deepEqual(old.steps, legacy.steps);
});

test('ongeldige of dubbele programma’s en ongeldige zonnedekking worden gecontroleerd zonder typenfouten', () => {
  for (const programs of [null, [], {}, [null], [{ name: '' }], [{ name: 'Eco', steps: 'fout' }], [{ name: 'Eco', steps: [null] }],
    [{ name: 'Eco', steps: [{ duration_minutes: 1, power_w: 0 }] }], [{ name: 'Eco', steps: [{ duration_minutes: 0, power_w: 100 }] }],
    [device().programs[0], { ...device().programs[1], name: ' eco ' }],
    [device().programs[0], { ...device().programs[1], id: 'eco' }]]) {
    assert.ok(validateProfile({ ...device(), programs }).length > 0, JSON.stringify(programs));
  }
  for (const value of [-1, 1.01, '0.8', true]) assert.ok(validateProfile({ ...device(), min_solar_share: value }).length > 0);
  for (const value of [undefined, null, 0, 0.8, 1]) assert.deepEqual(validateProfile({ ...device(), min_solar_share: value }), []);
  assert.ok(validateProfile(null).length > 0);
});

test('apparaatminimum heeft voorrang; ontbrekend of null valt terug op algemeen en nul blijft geldig voor alle programma’s', () => {
  const f = fixture(() => 800), appliance = device();
  appliance.min_solar_share = 0.8;
  const own = adviseAppliance(appliance, f.weather, f.context);
  assert.equal(own.minimum_solar_share_percent, 80); assert.equal(own.minimum_solar_share_source, 'appliance');
  assert.equal(own.can_start_now, true); assert.equal(own.program_name, 'Eco');
  assert.deepEqual(own.programs.map((program) => program.can_start_now), [true, false]);
  assert.deepEqual(own.programs.map((program) => program.minimum_solar_share_percent), [80, 80]);
  for (const value of [undefined, null]) {
    appliance.min_solar_share = value;
    const general = adviseAppliance(appliance, f.weather, f.context);
    assert.equal(general.minimum_solar_share_percent, 100); assert.equal(general.minimum_solar_share_source, 'general');
    assert.equal(general.can_start_now, false);
  }
  appliance.min_solar_share = 0;
  assert.ok(adviseAppliance(appliance, f.weather, f.context).programs.every((program) => program.can_start_now));
});

test('elk programma krijgt zijn eigen starttijd, energie en programmanaam; de samenvatting noemt het vroegst passende programma', () => {
  const f = fixture(), result = adviseAppliance(device(), f.weather, f.context);
  assert.equal(result.program_id, 'eco'); assert.equal(result.program_name, 'Eco');
  assert.equal(result.earliest_start, new Date(at(19, '08:30')).toISOString());
  const [eco, fast] = result.programs;
  assert.equal(eco.earliest_start, new Date(at(19, '08:30')).toISOString());
  assert.equal(fast.earliest_start, new Date(at(19, '09:00')).toISOString());
  assert.equal(eco.earliest.energy_wh, 525); assert.equal(fast.earliest.energy_wh, 375);
  assert.equal(fast.earliest.program_name, 'Snel'); assert.equal(fast.earliest.duration_minutes, 15);
  const chosen = adviseAppliance(device(), f.weather, f.context, 'snel');
  assert.equal(chosen.program_name, 'Snel'); assert.equal(chosen.programs.length, 1);
  assert.equal(chosen.earliest_start, fast.earliest_start);
  assert.throws(() => adviseAppliance(device(), f.weather, f.context, 'bestaat-niet'), /Onbekend programma/);
});

test('Meeste zon blijft per programma beschikbaar wanneer het apparaatminimum nergens gehaald wordt', () => {
  const f = fixture(() => 800), result = adviseAppliance(device(), f.weather, f.context);
  assert.equal(result.earliest_start, null); assert.equal(result.best_program_name, 'Eco');
  assert.equal(result.best.program_name, 'Eco');
  assert.equal(result.programs[0].best.solar_share_percent, 85.7);
  assert.equal(result.programs[1].best.solar_share_percent, 40);
  assert.ok(result.programs.every((program) => program.earliest_start === null));
});

test('dagadviezen beoordelen de eigen duur per programma, ook als één programma niet binnen het daglicht past', () => {
  const f = fixture(), appliance = device();
  appliance.programs.unshift({ id: 'lang', name: 'Heel lang', steps: [{ duration_minutes: 360, power_w: 1000 }] });
  const result = dailyAdvice([appliance], f.weather, f.context, f.repository);
  for (const [index, day] of result.days.entries()) {
    const item = day.appliances[0];
    assert.equal(item.status, 'ok'); assert.equal(item.program_name, 'Eco');
    assert.equal(item.programs[0].status, 'no_daylight_window');
    assert.equal(item.programs[1].earliest_start, new Date(at(19 + index, '08:30')).toISOString());
    assert.equal(item.programs[2].earliest_start, new Date(at(19 + index, '09:00')).toISOString());
  }
});

test('een actief apparaat met onbekend programma telt eenmaal mee met de hoogste mogelijke fase en langste duur', () => {
  const f = fixture(() => 2200), running = device();
  running.homewizard = { host: 'vaatwasser.local' };
  running.programs = [
    { name: 'A', steps: [{ duration_minutes: 15, power_w: 1500 }, { duration_minutes: 15, power_w: 100 }] },
    { name: 'B', steps: [{ duration_minutes: 15, power_w: 200 }, { duration_minutes: 45, power_w: 1200 }] }
  ];
  assert.deepEqual(programEnvelope(running).map((step) => step.power_w), [1500, 1200, 1200]);
  const repository = { applianceSocketState: () => ({ config_key: socketConfigKey(socketConfig(running)),
    state: { running: true, started_ms: now, measured_ms: now, power_w: 1500, error: null } }),
    applianceCycles: () => { throw new Error('Een oude cyclus mag niet als onbekend programma worden gekozen'); } };
  const demand = createActiveDemand([running], repository, f.settings, now);
  assert.equal(demand.metadata.length, 1); assert.equal(demand.metadata[0].source, 'program_envelope');
  assert.equal(demand.busyUntil(running.id), now + 60 * minute);
  assert.ok(Math.abs(demand.solarWh(now + minute, now + 15 * minute, 2000, 1000) - 500 * 14 / 60) < 1e-9);
  assert.equal(demand.solarWh(now + 15 * minute, now + 30 * minute, 2000, 1000), 200);
  const self = adviseAppliance(running, f.weather, { ...f.context, activeDemand: demand });
  assert.ok(self.programs.every((program) => program.can_start_now === false));
  assert.ok(self.programs.every((program) => Date.parse(program.earliest_start) >= now + 60 * minute));
});

/** Start de echte API met programmeerbare apparaat-JSON en SQLite; input: testcontext; output: dienst en aanvraaghelpers. */
async function httpFixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-program-http-')), profile = device();
  profile.homewizard = { host: '192.168.2.77' }; profile.private_extra = 'PRIVATE-PROGRAM';
  profile.programs[0].private_extra = 'PRIVATE-PROGRAM';
  const path = join(folder, 'vaatwasser.json'), write = () => writeFileSync(path, JSON.stringify(profile)); write();
  const { settings } = loadConfiguration();
  settings.http = { host: '127.0.0.1', port: 0 }; settings.location = { latitude: 52, longitude: 5 };
  settings.advice = { ...settings.advice, min_solar_share: 0.4, reserve_w: 100, baseload_w: 100, search_hours: 4 };
  const panels = { inverters: [{ id: 'test', serial: 'INV0000001', ac_limit_w: 3000 }],
    groups: [{ id: 'vlak', inverter_id: 'test', count: 1, wp_per_panel: 1000, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 }] };
  const db = openDatabase(':memory:'), repository = createRepository(db);
  for (const row of fixture().weather) repository.saveForecast({ ...row, source: 'test', ghi: row.power_w, dni: 0, dhi: row.power_w });
  for (const day of [19, 20, 21]) repository.saveSun(`2026-10-${day}`, at(day, '08:00'), at(day, '12:00'), 'test', now);
  t.mock.method(Date, 'now', () => now);
  const server = startHttpServer({ settings, panels, panelErrors: [], repository, profilesDirectory: folder,
    weather: { status: () => ({ source: 'test', sunrise: new Date(at(19, '08:00')).toISOString(), sunset: new Date(at(19, '12:00')).toISOString() }) },
    homewizard: { status: () => ({}) } });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(folder, { recursive: true, force: true }); });
  await once(server, 'listening');
  const request = (path) => fetch(`http://127.0.0.1:${server.address().port}${path}`);
  const get = async (path) => { const response = await request(path); assert.equal(response.status, 200); return response.json(); };
  return { settings, panels, repository, folder, profile, write, request, get };
}

test('interne API en openbare snapshot tonen programma-adviezen met dezelfde tijden en zonder steps of apparaat-IP', async (t) => {
  const f = await httpFixture(t), single = await f.get('/intern/api/v1/appliances/vaatwasser/advice');
  assert.equal(single.program_name, 'Eco'); assert.equal(single.programs.length, 2);
  assert.equal(single.programs[1].earliest_start, new Date(at(19, '09:00')).toISOString());
  const chosen = await f.get('/intern/api/v1/appliances/vaatwasser/advice?program=snel');
  assert.equal(chosen.program_name, 'Snel'); assert.equal(chosen.programs.length, 1);
  assert.equal((await f.request('/intern/api/v1/appliances/vaatwasser/advice?program=onbekend')).status, 404);
  const daily = await f.get('/intern/api/v1/appliances/daily'), snapshot = await f.get('/api/v1/dashboard');
  assert.equal(snapshot.profiles.profiles[0].programs.length, 2);
  assert.equal(snapshot.profiles.profiles[0].minimum_solar_share_percent, 100);
  assert.equal(snapshot.profiles.profiles[0].minimum_solar_share_source, 'appliance');
  for (let index = 0; index < 3; index++) for (let program = 0; program < 2; program++) {
    const internal = daily.days[index].appliances[0].programs[program], external = snapshot.daily.days[index].appliances[0].programs[program];
    assert.equal(external.program_name, internal.program_name); assert.equal(external.earliest_start, internal.earliest_start);
    assert.equal(external.best.solar_share, internal.best.solar_share);
  }
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE-PROGRAM'));
  assert.ok(!JSON.stringify(snapshot).includes('192.168.2.77'));
  assert.ok(!JSON.stringify(snapshot).includes('"steps"'));
  assert.equal(f.repository.lastCall(), null);
});

test('apparaatminimum wijzigen of verwijderen werkt bij de volgende aanvraag en een socket wordt per apparaat één keer gelezen', async (t) => {
  const f = await httpFixture(t);
  f.profile.min_solar_share = 0.8; f.write();
  assert.equal((await f.get('/api/v1/dashboard')).profiles.profiles[0].minimum_solar_share_percent, 80);
  f.profile.min_solar_share = null; f.write();
  const inherited = await f.get('/api/v1/dashboard');
  assert.equal(inherited.profiles.profiles[0].minimum_solar_share_percent, 40);
  assert.equal(inherited.profiles.profiles[0].minimum_solar_share_source, 'general');
  assert.ok(inherited.daily.days[0].appliances[0].programs.every((program) => program.can_start_now));
  let reads = 0;
  const poller = createSocketPoller(f.settings, f.repository, f.folder, async (device) => {
    reads++; return { device, net_power_w: 0, import_kwh: 0, export_kwh: 0, measured_ms: now, received_ms: now };
  }, () => now);
  const result = await poller.poll(); await poller.stop();
  assert.equal(result.sockets, 1); assert.equal(reads, 1);
});

/** Maakt testnodes en verzamelt de zichtbare kaarttekst; input: tag; output: eenvoudige DOM-node. */
function element(tagName) {
  return { tagName, textContent: '', className: '', children: [], attributes: {},
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, setAttribute(key, value) { this.attributes[key] = value; } };
}
function text(node) { return [node.textContent, ...node.children.map(text)].filter(Boolean).join(' '); }

test('dashboard groepeert adviezen per benoemd programma en toont het effectieve apparaatminimum', async (t) => {
  const f = await httpFixture(t), snapshot = await f.get('/api/v1/dashboard');
  const before = globalThis.document; t.after(() => { globalThis.document = before; });
  globalThis.document = { createElement: element };
  const container = element('div'); renderDailyAdvice(container, snapshot.profiles.profiles, snapshot.daily);
  assert.equal(container.children.length, 1);
  const card = container.children[0], sections = card.children.filter((child) => child.className === 'appliance-program');
  assert.equal(sections.length, 2); assert.equal(sections[0].children[0].textContent, 'Eco'); assert.equal(sections[1].children[0].textContent, 'Snel');
  assert.match(text(card), /Minimale zonnedekking: 100%/);
  assert.match(text(sections[0]), /45 min/); assert.match(text(sections[1]), /15 min/);
  assert.match(text(sections[0]), /10:30/); assert.match(text(sections[1]), /11:00/);
  const profile = snapshot.profiles.profiles[0]; profile.activity = { configured: true, state: 'running', running: true, power_w: 100 };
  renderDailyAdvice(container, [profile], snapshot.daily);
  assert.match(text(container), /Apparaat bezig/);
  profile.programs[0].name = '<img src=x onerror=alert(1)>';
  renderDailyAdvice(container, [profile], snapshot.daily);
  const heading = container.children[0].children.find((child) => child.className === 'appliance-program').children[0];
  assert.equal(heading.textContent, '<img src=x onerror=alert(1)>'); assert.deepEqual(heading.children, []);
});
