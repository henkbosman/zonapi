import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActiveDemand, clippedSolarEnergy } from '../src/appliances/active-demand.js';
import { socketConfig, socketConfigKey } from '../src/appliances/socket-config.js';
import { advise, evaluateStart } from '../src/appliances/start-advice.js';
import { dailyAdvice } from '../src/appliances/daily-advice.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { loadConfiguration } from '../src/config/load.js';
import { startHttpServer } from '../src/api/http-server.js';
import { localDay } from '../src/weather/local-day.js';

const minute = 60000, now = Date.parse('2026-10-17T10:15:00Z');

/** Maakt een verbruiksprofiel met optionele socket; input: id, fasen en socketvlag; output: profiel. */
function appliance(id, steps, socket = false) {
  return { id, name: id, duration_minutes: steps.reduce((sum, step) => sum + step.duration_minutes, 0), steps,
    ...(socket ? { homewizard: { host: `${id}.local` } } : {}) };
}

/** Bouwt een vaste PV-prognose en injecteerbare actuele socketstatus; input: optionele peiltijd en PV-vermogen; output: adviescontext, bronopslag en helpers. */
function fixture(at = now, pv = 1600) {
  const { settings } = loadConfiguration();
  settings.homewizard.poll_seconds = 30;
  settings.advice = { ...settings.advice, search_hours: 4, reserve_w: 0, baseload_w: 400, min_solar_share: 1 };
  const states = new Map(), cycles = new Map();
  const repository = {
    applianceSocketState: (id) => states.get(id) ?? null,
    applianceCycles: (id) => cycles.get(id) ?? [],
    getSun: (day) => ({ sunrise_ms: Date.parse(`${day}T06:00:00Z`), sunset_ms: Date.parse(`${day}T18:00:00Z`) })
  };
  const weather = [];
  for (let start = Math.floor(at / 900000) * 900000; start < at + 74 * 3600000; start += 900000) weather.push({ start_ms: start, end_ms: start + 900000, fetched_ms: at });
  const context = { now: at, settings, panels: {}, panelErrors: [], latitude: 52, longitude: 5,
    baseload: { power_w: 400, source: 'config' }, pvModel: { estimate: () => ({ power_w: pv }) } };
  return { at, settings, states, cycles, repository, weather, context,
    active(profile, start = at, power = profile.steps[0].power_w, extra = {}) {
      states.set(profile.id, { config_key: socketConfigKey(socketConfig(profile)), state: { running: true, started_ms: start,
        measured_ms: at, power_w: power, pending_start_ms: null, error: null, ...extra } });
    },
    demand(profiles) { return createActiveDemand(profiles, repository, settings, at); }
  };
}

test('integratie begrenst een lineair verbruik op nul en apparaatvermogen zonder kwartiergemiddelden te gebruiken', () => {
  assert.equal(clippedSolarEnergy(-100, 300, 100, 1), 62.5);
  assert.equal(clippedSolarEnergy(300, -100, 100, 1), 62.5);
  assert.equal(clippedSolarEnergy(50, 150, 100, 1), 87.5);
  assert.equal(clippedSolarEnergy(-200, -100, 100, 1), 0);
  assert.equal(clippedSolarEnergy(500, 500, 100, 0.5), 50);
});

test('resterende JSON-fasen verschuiven het andere startadvies; na het aflopen van de zware fase is het vermogen weer vrij', () => {
  const f = fixture();
  const dryer = appliance('droger', [{ duration_minutes: 20, power_w: 1000 }, { duration_minutes: 40, power_w: 200 }], true);
  const washer = appliance('wasmachine', [{ duration_minutes: 10, power_w: 1000 }]);
  f.active(dryer, now - 15 * minute);
  const alone = advise(washer, f.weather, f.context);
  const demand = f.demand([dryer, washer]), context = { ...f.context, activeDemand: demand };
  const shared = advise(washer, f.weather, context);
  assert.equal(alone.can_start_now, true);
  assert.equal(shared.now.solar_share_percent, 60);
  assert.equal(shared.can_start_now, false);
  assert.equal(shared.earliest_start, '2026-10-17T10:20:00.000Z');
  assert.equal(shared.active_appliances[0].source, 'profile');
  assert.equal(shared.active_appliances[0].remaining_minutes, 45);
  const before = evaluateStart(washer, now + 4 * minute, f.weather, context);
  const after = evaluateStart(washer, now + 5 * minute, f.weather, context);
  assert.ok(before.solar_share_percent < 100);
  assert.equal(after.solar_share_percent, 100);
});

test('meerdere actieve apparaten tellen samen, basislast en reserve worden elk één keer afgetrokken', () => {
  const f = fixture(now, 2200);
  f.context.baseload.power_w = 200;
  f.settings.advice.reserve_w = 100;
  const a = appliance('droger', [{ duration_minutes: 30, power_w: 1000 }], true);
  const b = appliance('vaatwasser', [{ duration_minutes: 30, power_w: 600 }], true);
  const target = appliance('wasmachine', [{ duration_minutes: 10, power_w: 400 }]);
  f.active(a, now - 5 * minute); f.active(b, now - 5 * minute);
  const result = advise(target, f.weather, { ...f.context, activeDemand: f.demand([a, b, target]) });
  assert.equal(result.now.solar_share_percent, 75);
  assert.equal(result.can_start_now, false);
  assert.equal(result.earliest_start, '2026-10-17T10:40:00.000Z');
  assert.deepEqual(result.active_appliances.map((item) => item.id), ['droger', 'vaatwasser']);
  target.reserve_w = 0;
  const noReserve = advise(target, f.weather, { ...f.context, activeDemand: f.demand([a, b, target]) });
  assert.equal(noReserve.now.solar_share_percent, 100);
  assert.equal(noReserve.can_start_now, true);
});

test('de vorige volledige cyclus bepaalt het resterende verloop met dezelfde lineaire fasen als de grafiek', () => {
  const f = fixture(now, 1000); f.context.baseload.power_w = 0;
  const running = appliance('droger', [{ duration_minutes: 90, power_w: 2000 }], true);
  const target = appliance('wasmachine', [{ duration_minutes: 1, power_w: 500 }]);
  const old = now - 86400000;
  f.cycles.set(running.id, [{ state: 'completed', complete: true, started_ms: old, ended_ms: old + 90000, gap_ms: 120000,
    points: [[0, 1000], [30, 1000], [60, 0], [90, 0]].map(([seconds, power_w]) => ({ measured_ms: old + seconds * 1000, power_w })) }]);
  f.active(running, now, 1000);
  const activeDemand = f.demand([running, target]);
  const result = evaluateStart(target, now, f.weather, { ...f.context, activeDemand });
  assert.equal(result.solar_share_percent, 37.5);
  assert.equal(activeDemand.metadata[0].source, 'previous_cycle');
  assert.equal(activeDemand.busyUntil(running.id), now + 90000);
  f.cycles.get(running.id)[0].complete = false;
  assert.equal(f.demand([running, target]).metadata[0].source, 'profile');
});

test('een actief apparaat krijgt geen tweede overlappende start en wordt na de verwachte eindtijd niet dubbel meegeteld', () => {
  const f = fixture(now, 10000);
  const dryer = appliance('droger', [{ duration_minutes: 20, power_w: 1000 }, { duration_minutes: 40, power_w: 200 }], true);
  f.active(dryer, now - 15 * minute);
  const result = advise(dryer, f.weather, { ...f.context, activeDemand: f.demand([dryer]) });
  assert.equal(result.can_start_now, false);
  assert.equal(result.already_active, true);
  assert.equal(result.busy_until, '2026-10-17T11:00:00.000Z');
  assert.equal(result.earliest_start, result.busy_until);
  assert.equal(result.earliest.solar_share_percent, 100);
  assert.deepEqual(result.active_appliances, []);
  const shortWindow = advise(dryer, f.weather, { ...f.context, activeDemand: f.demand([dryer]), window: { from: now, until: now + 10 * minute } });
  assert.equal(shortWindow.status, 'already_active');
  assert.equal(shortWindow.can_start_now, false);
});

test('gelijktijdige geleerde fasen worden opgeteld en na hun einde blijft geen restbelasting achter', () => {
  const f = fixture(now, 2000); f.context.baseload.power_w = 0;
  const a = appliance('droger', [{ duration_minutes: 60, power_w: 1200 }], true);
  const b = appliance('vaatwasser', [{ duration_minutes: 60, power_w: 400 }], true);
  const target = appliance('wasmachine', [{ duration_minutes: 1, power_w: 1000 }]);
  const old = now - 86400000;
  for (const [profile, samples] of [[a, [[0, 1200], [30, 1200], [60, 0]]], [b, [[0, 400], [30, 400], [60, 400], [90, 0]]]]) {
    f.active(profile);
    f.cycles.set(profile.id, [{ state: 'completed', complete: true, started_ms: old, ended_ms: old + samples.at(-1)[0] * 1000, gap_ms: 120000,
      points: samples.map(([seconds, power_w]) => ({ measured_ms: old + seconds * 1000, power_w })) }]);
  }
  const activeDemand = f.demand([a, b, target]);
  assert.equal(evaluateStart(target, now, f.weather, { ...f.context, activeDemand }).solar_share_percent, 62.5);
  assert.ok(Math.abs(activeDemand.solarWh(now + 90000, now + 150000, 2000, 1000) - 1000 / 60) < 1e-8);
});

test('de eerste pollperiode gebruikt het gemeten apparaatvermogen en daarna het verwachte faseverloop', () => {
  const f = fixture(), running = appliance('droger', [{ duration_minutes: 60, power_w: 200 }], true);
  const target = appliance('wasmachine', [{ duration_minutes: 1, power_w: 1000 }]);
  f.active(running, now, 1000);
  const result = evaluateStart(target, now, f.weather, { ...f.context, activeDemand: f.demand([running, target]) });
  assert.equal(result.solar_share_percent, 60);
});

test('een bevestigde stop geeft stroom vrij; een meetfout laat laatst bekende actieve belasting niet plots verdwijnen', () => {
  const f = fixture(now, 1600), running = appliance('droger', [{ duration_minutes: 60, power_w: 1000 }], true);
  const target = appliance('wasmachine', [{ duration_minutes: 10, power_w: 1000 }]);
  f.active(running, now - 15 * minute);
  const before = advise(target, f.weather, { ...f.context, activeDemand: f.demand([running, target]) });
  assert.equal(before.can_start_now, false);
  const saved = f.states.get(running.id);
  saved.state.error = 'time-out';
  const uncertain = f.demand([running, target]);
  assert.equal(uncertain.metadata[0].fresh, false);
  assert.equal(uncertain.metadata[0].state, 'last_known_running');
  assert.equal(advise(target, f.weather, { ...f.context, activeDemand: uncertain }).can_start_now, false);
  saved.state.error = null; saved.state.running = false; saved.state.power_w = 0;
  const after = advise(target, f.weather, { ...f.context, activeDemand: f.demand([running, target]) });
  assert.equal(after.can_start_now, true);
  assert.deepEqual(after.active_appliances, []);
});

test('langer draaiende apparaten blijven meetellen; zonder actuele meetwaarde wordt een voorzichtige belasting gebruikt', () => {
  const f = fixture(now, 1600), running = appliance('droger', [{ duration_minutes: 30, power_w: 1800 }], true);
  const target = appliance('wasmachine', [{ duration_minutes: 10, power_w: 500 }]);
  f.active(running, now - 60 * minute, 1500);
  let activeDemand = f.demand([running, target]);
  assert.equal(activeDemand.metadata[0].overrun, true);
  assert.equal(activeDemand.metadata[0].source, 'current_power');
  assert.equal(activeDemand.metadata[0].remaining_minutes, 30);
  assert.equal(evaluateStart(target, now, f.weather, { ...f.context, activeDemand }).solar_share_percent, 0);
  const saved = f.states.get(running.id); saved.state.measured_ms = now - 121000; saved.state.power_w = 0;
  activeDemand = f.demand([running, target]);
  assert.equal(activeDemand.metadata[0].fresh, false);
  assert.equal(evaluateStart(target, now, f.weather, { ...f.context, activeDemand }).solar_share_percent, 0);
});

test('startkandidaten reserveren al vermogen en een gewijzigde of uitgeschakelde socket neemt geen oude aanstatus over', () => {
  const f = fixture(), running = appliance('droger', [{ duration_minutes: 30, power_w: 1000 }], true);
  f.active(running, now, 1000, { running: false, started_ms: null, pending_start_ms: now });
  assert.equal(f.demand([running]).metadata[0].state, 'starting');
  f.states.get(running.id).state.pending_start_ms = null;
  assert.deepEqual(f.demand([running]).metadata, []);
  f.active(running);
  running.homewizard.host = 'ander-adres.local';
  assert.deepEqual(f.demand([running]).metadata, []);
  running.homewizard.host = '';
  assert.deepEqual(f.demand([running]).metadata, []);
});

test('dagadvies gebruikt dezelfde reservering vandaag en laat morgen vrij wanneer de actieve cyclus vandaag eindigt', () => {
  const f = fixture(), running = appliance('droger', [{ duration_minutes: 20, power_w: 1000 }, { duration_minutes: 40, power_w: 200 }], true);
  const target = appliance('wasmachine', [{ duration_minutes: 10, power_w: 1000 }]);
  f.active(running, now - 15 * minute);
  const result = dailyAdvice([running, target], f.weather, f.context, f.repository);
  const today = result.days[0].appliances.find((item) => item.id === target.id);
  const tomorrow = result.days[1].appliances.find((item) => item.id === target.id);
  assert.equal(today.earliest_start, '2026-10-17T10:20:00.000Z');
  assert.equal(tomorrow.earliest_start, result.days[1].sunrise);
  assert.equal(tomorrow.earliest.solar_share_percent, 100);
  assert.equal(result.active_appliances.length, 1);
  assert.equal(result.days[0].appliances.find((item) => item.id === running.id).can_start_now, false);
});

test('een faseovergang rond wintertijd houdt dezelfde werkelijke resterende duur', () => {
  const at = Date.parse('2026-10-25T00:50:00Z'), f = fixture(at);
  const running = appliance('droger', [{ duration_minutes: 20, power_w: 1000 }, { duration_minutes: 40, power_w: 200 }], true);
  const target = appliance('wasmachine', [{ duration_minutes: 10, power_w: 1000 }]);
  f.active(running, at - 10 * minute);
  const result = advise(target, f.weather, { ...f.context, activeDemand: f.demand([running, target]) });
  assert.equal(result.earliest_start, '2026-10-25T01:00:00.000Z');
  assert.equal(result.active_appliances[0].remaining_minutes, 50);
  assert.equal(Date.parse(result.active_appliances[0].expected_end) - at, 50 * minute);
});

test('HTTP- en dashboardadvies wijzigen na socketstart en herstellen na stop zonder configuratiewijziging of extra bronverzoek', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-active-advice-')), db = openDatabase(':memory:'), repository = createRepository(db);
  const at = Date.now(), from = Math.floor(at / 900000) * 900000;
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, location: { latitude: 52, longitude: 5 },
    pv: { calibration_factor: 1, automatic_correction: { enabled: false } },
    advice: { ...defaults.advice, baseload_w: 400, reserve_w: 0, min_solar_share: 1 } };
  const panels = { expected_panel_count: 20, inverters: [{ id: 'a', serial: '', ac_limit_w: 10000 }],
    groups: [{ id: 'a', inverter_id: 'a', count: 20, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 }] };
  const running = appliance('droger', [{ duration_minutes: 60, power_w: 1000 }], true), target = appliance('wasmachine', [{ duration_minutes: 10, power_w: 1000 }]);
  for (const profile of [running, target]) writeFileSync(join(folder, `${profile.id}.json`), JSON.stringify(profile));
  for (let start = from - 3600000; start < from + 75 * 3600000; start += 900000) repository.saveForecast({ source: 'test', start_ms: start, end_ms: start + 900000, ghi: 200, dni: 0, dhi: 200, fetched_ms: at });
  repository.saveSun(localDay(at), at - 3600000, at + 10 * 3600000, 'test', at);
  const server = startHttpServer({ settings, panels, panelErrors: [], repository, profilesDirectory: folder,
    weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const path = '/api/v1/appliances/wasmachine/advice';
    assert.equal((await (await fetch(url + path)).json()).can_start_now, true);
    repository.saveApplianceSocketState({ appliance_id: running.id, config_key: socketConfigKey(socketConfig(running)), updated_ms: at,
      state: { running: true, started_ms: at - 5 * minute, measured_ms: at, power_w: 1000, pending_start_ms: null, pending_stop_ms: null, error: null } });
    const active = await (await fetch(url + path)).json();
    assert.equal(active.can_start_now, false);
    assert.equal(active.now.solar_share_percent, 20);
    assert.equal(active.active_appliances[0].id, running.id);
    const daily = await (await fetch(url + '/api/v1/appliances/daily')).json();
    assert.equal(daily.days[0].appliances.find((item) => item.id === target.id).can_start_now, false);
    assert.equal(daily.active_appliances[0].id, running.id);
    const saved = repository.applianceSocketState(running.id);
    const later = Date.now();
    repository.saveApplianceSocketState({ ...saved, updated_ms: later, state: { ...saved.state, running: false, power_w: 0, measured_ms: later, stopped_ms: later } });
    const stopped = await (await fetch(url + path)).json();
    assert.equal(stopped.can_start_now, true);
    assert.deepEqual(stopped.active_appliances, []);
    assert.equal(repository.countCalls(localDay(at)), 0);
    assert.equal(repository.currentMeters().length, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(folder, { recursive: true, force: true }); }
});
