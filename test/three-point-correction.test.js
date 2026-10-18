import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration, validateSettings } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { automaticCorrectionConfig } from '../src/pv/automatic-config.js';
import { filterCorrectionSamples, fiveMinuteSamples } from '../src/pv/correction-samples.js';
import { learnQuarterCorrection } from '../src/pv/learn-quarter-correction.js';
import { createPvForecastModel } from '../src/pv/forecast-model.js';
import { correctionModelKey } from '../src/pv/correction-key.js';
import { createGrowattCloudClient } from '../src/growatt/cloud/client.js';
import { createGrowattCloudPoller } from '../src/growatt/cloud/poller.js';
import { growattCloudConfig } from '../src/growatt/cloud/config.js';
import { startHttpServer } from '../src/api/http-server.js';
import { renderGrowattCloud } from '../public/growatt-cloud.js';
import { createPvCorrectionLearner } from '../src/pv/correction-learner.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { renderPvCorrection } from '../public/pv-correction-status.js';

const five = 300000, quarter = 900000, minute = 60000;
const target = Date.parse('2026-10-18T07:15:00Z'); // 09:15 in Nederland.
const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];
const iso = (ms) => new Date(ms).toISOString();

/** Bouwt een vlak paneelmodel met echte opslag en kwartierdata; input: testcontext en optionele grens-/opslagkeuze; output: context met voeg-/leerhelpers. */
function fixture(t, { automatic = {}, path = ':memory:', weather = true, center = target } = {}) {
  const { settings } = loadConfiguration();
  settings.location = { latitude: 52, longitude: 5 }; settings.http = { host: '127.0.0.1', port: 0 };
  settings.pv = { calibration_factor: 1, automatic_correction: automatic };
  settings.growatt = { ...settings.growatt, production_source: 'cloud', cloud: { token: 'test-window-token', poll_seconds: 900 } };
  const panels = { inverters: serials.map((serial, index) => ({ id: `mic-${index}`, serial, ac_limit_w: 2000 })),
    groups: serials.map((_, index) => ({ id: `vlak-${index}`, inverter_id: `mic-${index}`, count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 })) };
  const f = { db: openDatabase(path), now: center - 10 * minute, target: center, settings, panels };
  f.repository = createRepository(f.db);
  f.forecast = (power = 1000, fetched = f.now) => {
    for (let start = f.target - 2 * 3600000; start < f.target + 74 * 3600000; start += quarter) f.repository.saveForecast({ source: 'open-meteo', model: 'icon_d2',
      start_ms: start, end_ms: start + quarter, ghi: power / 8, dni: 0, dhi: power / 8, fetched_ms: fetched });
  };
  if (weather) f.forecast();
  f.add = (time, power, { skew = [0, 0, 0, 0], omit = [], received = time + five + 1000 } = {}) => {
    f.now = Math.max(f.now, received);
    const rows = serials.flatMap((serial, index) => omit.includes(index) ? [] : [{ serial, source: 'cloud', measured_ms: time + skew[index],
      received_ms: received, power_w: power / 4, energy_today_kwh: 1, energy_total_kwh: 100 }]);
    for (const row of rows) f.repository.saveCloudInverter(row);
    return rows;
  };
  f.learn = () => learnQuarterCorrection(f.repository, f.settings, f.panels, [], f.repository.currentCloudInverters(), f.now);
  f.pattern = () => f.repository.pvBlockCorrections(correctionModelKey(f.settings, f.panels));
  f.trio = (powers = [800, 820, 840], options = {}) => { for (let i = 0; i < 3; i++) f.add(f.target + (i - 1) * five, powers[i], options); };
  t.after(() => f.db.close());
  return f;
}

test('09:15-correctie wacht op de echte metingen 09:10, 09:15 en 09:20, ook bij vijf minuten aanleververtraging', (t) => {
  const f = fixture(t);
  f.add(target - five, 800);
  let result = f.learn();
  assert.equal(result.status, 'waiting_for_samples');
  assert.equal(result.target_time, iso(target));
  assert.equal(result.received_samples, 1);
  assert.deepEqual(result.missing_times, [target, target + five].map(iso));
  f.add(target, 820);
  assert.equal(f.learn().received_samples, 2);
  assert.equal(f.pattern().length, 0);
  f.add(target + five, 840);
  result = f.learn();
  assert.equal(result.status, 'updated');
  assert.equal(result.time, '09:15');
  assert.equal(result.factor, 0.82);
  assert.equal(result.sampling.used_samples, 3);
  assert.deepEqual(result.sampling.samples.map((row) => row.time), [target - five, target, target + five].map(iso));
  assert.equal(f.pattern()[0].measured_w, 820);
  assert.equal(f.pattern()[0].predicted_w, 1000);
  const stored = JSON.parse(f.pattern()[0].sampling_json);
  assert.equal(stored.forecast.end, iso(target));
  assert.equal(stored.forecast.start, iso(target - quarter));
});

test('de voorspelling op de eindklok wordt gebruikt, zonder vermenging met het volgende Open-Meteo-kwartier', (t) => {
  const f = fixture(t);
  f.repository.saveForecast({ source: 'open-meteo', model: 'icon_d2', start_ms: target, end_ms: target + quarter,
    ghi: 500, dni: 0, dhi: 500, fetched_ms: f.now + 1 });
  f.trio();
  assert.equal(f.learn().factor, 0.82);
  assert.equal(f.pattern()[0].predicted_w, 1000);
});

test('een hoge of lage uitschieter op ieder van de drie posities wordt alleen voor de correctie genegeerd', (t) => {
  for (const index of [0, 1, 2]) for (const extreme of [0, 2000]) {
    const f = fixture(t), powers = [800, 820]; powers.splice(index, 0, extreme);
    f.trio(powers);
    const before = f.repository.cloudInverterHistory(target - five - 1, target + five + 1).map((row) => ({ ...row }));
    const result = f.learn();
    assert.equal(result.factor, 0.81);
    assert.equal(result.sampling.used_samples, 2);
    assert.deepEqual(result.sampling.ignored_times, [iso(target + (index - 1) * five)]);
    assert.deepEqual(result.sampling.samples.map((row) => row.used), [0, 1, 2].map((i) => i !== index));
    assert.deepEqual(f.repository.cloudInverterHistory(target - five - 1, target + five + 1).map((row) => ({ ...row })), before);
  }
});

test('een brede trend en drie gelijkwaardige of nulmetingen blijven behouden; zonder overeenkomend paar wordt niet gegokt', () => {
  const config = automaticCorrectionConfig({});
  for (const powers of [[1000, 1300, 1600], [800, 1000, 1800], [800, 800, 800], [0, 0, 0], [1000, 1100, 1200]]) {
    assert.deepEqual(filterCorrectionSamples(powers.map((power_w) => ({ power_w })), config).used, [0, 1, 2]);
  }
  assert.deepEqual(filterCorrectionSamples([800, 2000, 820].map((power_w) => ({ power_w })), config).ignored, [1]);
});

test('een ontbrekend compleet meetmoment of één ontbrekende omvormer levert geen tweepuntscorrectie op', (t) => {
  const f = fixture(t);
  f.add(target - five, 800); f.add(target, 820, { omit: [3] }); f.add(target + five, 840);
  const result = f.learn();
  assert.equal(result.status, 'waiting_for_samples');
  assert.equal(result.received_samples, 2);
  assert.deepEqual(result.missing_times, [iso(target)]);
  assert.equal(f.pattern().length, 0);
});

test('herhaald ontvangen oude antwoorden vullen het ontbrekende middelste meetmoment niet op', (t) => {
  const f = fixture(t);
  f.add(target - five, 800);
  f.add(target - five, 800, { received: target + five });
  f.add(target + five, 840);
  assert.equal(f.learn().status, 'waiting_for_samples');
  assert.equal(f.pattern().length, 0);
  assert.equal(f.repository.cloudInverterHistory(0, Infinity).length, 8);
});

test('kleine klokafwijkingen worden aan nabije vijfminutenmomenten gekoppeld en ruwe tijden blijven behouden', (t) => {
  const f = fixture(t);
  f.trio([800, 820, 840], { skew: [-10000, 1000, 5000, 11000] });
  const result = f.learn();
  assert.equal(result.factor, 0.82);
  assert.equal(result.target_time, iso(target));
  assert.equal(result.sampling.samples[1].measured_from, iso(target - 10000));
  assert.equal(result.sampling.samples[1].measured_to, iso(target + 11000));
  assert.equal(result.sampling.samples[1].inverters[0].measured_at, iso(target - 10000));
});

test('de oude standaard van 90 seconden blokkeert geen geldige Growatt-meetklok tussen vijfminutengrenzen', (t) => {
  for (const automatic of [{}, { sample_tolerance_seconds: 90 }]) for (const offset of [-149000, -134000, -91000, 91000, 134000, 149000]) {
    const f = fixture(t, { automatic });
    f.trio([800, 820, 840], { skew: serials.map(() => offset) });
    const before = f.repository.cloudInverterHistory(0, Infinity).map((row) => ({ ...row }));
    const result = f.learn();
    assert.equal(result.status, 'updated', `offset ${offset} met ${JSON.stringify(automatic)}`);
    assert.equal(result.factor, 0.82); assert.equal(f.pattern().length, 1);
    assert.deepEqual(result.sampling.samples.map((sample) => sample.time), [target - five, target, target + five].map(iso));
    assert.equal(result.sampling.samples[1].inverters[0].measured_at, iso(target + offset));
    assert.deepEqual(f.repository.cloudInverterHistory(0, Infinity).map((row) => ({ ...row })), before);
  }
});

test('een expliciete strenge tijdsgrens of te grote onderlinge spreiding maakt een meetmoment onbruikbaar', (t) => {
  for (const [automatic, skew] of [[{ sample_tolerance_seconds: 60 }, [61000, 0, 0, 0]], [{ max_skew_seconds: 10 }, [0, 0, 0, 11000]]]) {
    const f = fixture(t, { automatic }); f.trio([800, 820, 840], { skew });
    assert.equal(f.learn().status, 'waiting_for_samples');
    assert.equal(f.pattern().length, 0);
  }
});

test('één bronmeting kan niet voor twee tijdstippen worden hergebruikt en de dichtstbijzijnde klok krijgt voorrang', () => {
  const config = automaticCorrectionConfig({});
  const rows = [{ serial: serials[0], power_w: 100, measured_ms: target - 80000, received_ms: target },
    { serial: serials[0], power_w: 200, measured_ms: target + 1000, received_ms: target + five }];
  const result = fiveMinuteSamples(rows, [serials[0]], config, target + five);
  assert.equal(result.complete.size, 1);
  assert.equal(result.complete.get(target).power_w, 200);
});

test('een meting precies halverwege twee klokgrenzen vult één moment en een ontbrekend buurmoment wordt nooit ingevuld', (t) => {
  const config = automaticCorrectionConfig({});
  const result = fiveMinuteSamples([{ serial: serials[0], power_w: 100, measured_ms: target + five / 2, received_ms: target + five }], [serials[0]], config, target + five);
  assert.equal(result.complete.size, 1); assert.equal(result.complete.has(target + five), true); assert.equal(result.complete.has(target), false);
  const f = fixture(t);
  f.add(target - five, 800, { skew: serials.map(() => -134000) });
  f.add(target + five, 840, { skew: serials.map(() => -134000) });
  assert.equal(f.learn().status, 'waiting_for_samples'); assert.equal(f.pattern().length, 0);
});

test('filter- en klokgrenzen zijn optioneel, gevalideerd en instelbaar', (t) => {
  const f = fixture(t);
  for (const automatic of [{ sample_tolerance_seconds: 151 }, { sample_tolerance_seconds: -1 }, { outlier_relative: 0 }, { outlier_relative: 3 }, { outlier_min_w: -1 }]) {
    assert.ok(validateSettings({ ...f.settings, pv: { automatic_correction: automatic } }).some((error) => error.startsWith('pv.automatic_correction')));
  }
  f.settings.pv.automatic_correction = { outlier_relative: 2, outlier_min_w: 20000 };
  f.trio([800, 2000, 820]);
  assert.equal(f.learn().sampling.used_samples, 3);
  assert.equal(automaticCorrectionConfig({}).sample_tolerance_seconds, 150);
  assert.equal(automaticCorrectionConfig({ pv: { automatic_correction: { sample_tolerance_seconds: 90 } } }).sample_tolerance_seconds, 150);
  for (const limit of [0, 30, 60, 149, 150]) assert.equal(automaticCorrectionConfig({ pv: { automatic_correction: { sample_tolerance_seconds: limit } } }).sample_tolerance_seconds, limit);
});

test('dezelfde drie metingen worden niet opnieuw gestapeld en nieuwe weerdata gebruikt dezelfde ongecorrigeerde basis', (t) => {
  const f = fixture(t); f.trio();
  assert.equal(f.learn().factor, 0.82);
  const signature = f.pattern()[0].signature, computed = f.pattern()[0].updated_ms;
  f.now += 1000;
  assert.equal(f.learn().status, 'unchanged');
  assert.equal(f.pattern()[0].signature, signature);
  assert.equal(f.pattern()[0].updated_ms, computed);
  f.forecast(2000, f.now);
  assert.equal(f.learn().factor, 0.41);
  assert.equal(f.pattern()[0].measured_w, 820);
  assert.equal(f.pattern()[0].predicted_w, 2000);
  assert.equal(f.pattern().length, 1);
});

test('driepuntsonderbouwing overleeft een databaseherstart en het wissen of uitschakelen van diagnose', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-three-point-'));
  const f = fixture(t, { path: join(folder, 'state.sqlite') });
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  f.trio([800, 2000, 820]); assert.equal(f.learn().factor, 0.81);
  const before = f.pattern()[0].sampling_json;
  f.repository.clearGrowattDiagnostics(); f.repository.setLogging('growatt', false);
  f.db.close(); f.db = openDatabase(join(folder, 'state.sqlite')); f.repository = createRepository(f.db);
  assert.equal(f.learn().status, 'unchanged');
  assert.equal(f.pattern()[0].sampling_json, before);
  const status = createPvForecastModel(f.repository, f.settings, f.panels, f.now).status();
  assert.equal(status.latest.sampling.used_samples, 2);
  assert.equal(status.latest.sampling.samples[1].used, false);
});

test('nulproductie blijft mogelijk en lage of ontbrekende voorspelling, te oude data en onvolledige configuratie leren niet', (t) => {
  const zero = fixture(t); zero.trio([0, 0, 0]);
  assert.equal(zero.learn().factor, 0);
  const missing = fixture(t, { weather: false }); missing.trio();
  assert.equal(missing.learn().status, 'forecast_unavailable');
  const low = fixture(t); low.forecast(50, low.now + 1); low.trio();
  assert.equal(low.learn().status, 'low_forecast');
  const old = fixture(t); old.trio(); old.now += 21 * minute;
  assert.equal(old.learn().status, 'stale');
  const invalid = fixture(t); invalid.trio();
  assert.equal(learnQuarterCorrection(invalid.repository, invalid.settings, invalid.panels, ['paneel ontbreekt'], invalid.repository.currentCloudInverters(), invalid.now).status, 'configuration_incomplete');
  const disabled = fixture(t, { automatic: { enabled: false } }); disabled.trio();
  assert.equal(disabled.learn().status, 'disabled');
});

test('driepuntsvensters rond de terugkerende wintertijd gebruiken aparte UTC-meetmomenten en het nieuwste klokpatroon', (t) => {
  const f = fixture(t, { center: Date.parse('2026-10-25T00:15:00Z') });
  f.trio([800, 800, 800]);
  assert.equal(f.learn().time, '02:15');
  f.target += 3600000; f.forecast(); f.trio([1200, 1200, 1200]);
  const later = f.learn();
  assert.equal(later.time, '02:15');
  assert.equal(later.factor, 1.2);
  assert.equal(f.pattern().length, 2);
  assert.ok(later.sampling.samples.every((sample) => Date.parse(sample.time) >= Date.parse('2026-10-25T01:10:00Z')));
});

test('vijfminutenopvragen met vertraagde Growatt-antwoorden sturen de driepuntscorrectie, API en dashboardweergave', async (t) => {
  const f = fixture(t);
  f.now = target - 6 * minute;
  t.mock.method(Date, 'now', () => f.now);
  f.repository.saveSun('2026-10-18', target - 2 * 3600000, target + 10 * 3600000, 'test', f.now);
  let roundStart, calls = 0;
  const client = createGrowattCloudClient(growattCloudConfig(f.settings), 'test-window-token', {
    clock: () => f.now, pause: async (ms) => { f.now += ms; }, onCall: f.repository.saveGrowattCloudCall,
    fetcher: async (_, options) => {
      calls++;
      const serial = new URLSearchParams(options.body).get('deviceSn'), measured = roundStart - five;
      const total = measured === target ? 2000 : measured < target ? 800 : 820;
      f.now += 50;
      return Response.json({ code: 0, data: { min: [{ serialNum: serial, time: iso(measured + serials.indexOf(serial) * 1000),
        pac: total / 4, eacToday: 1, eacTotal: 100 }] } });
    }
  });
  const cloud = createGrowattCloudPoller({ ...f, clock: () => f.now, environment: {}, client,
    onMeasurements: (rows, now) => learnQuarterCorrection(f.repository, f.settings, f.panels, [], rows, now) });
  t.after(() => cloud.stop());
  for (const time of [target - five, target, target + five, target + 2 * five]) {
    f.now = time; roundStart = time;
    const result = await cloud.poll();
    assert.equal(result.attempted, true);
    assert.equal(result.status.next_fetch, iso(time + five));
    if (time < target + 2 * five) assert.equal(f.pattern().length, 0);
  }
  assert.equal(calls, 16);
  assert.equal(cloud.status().forecast_correction.factor, 0.81);
  const server = startHttpServer({ ...f, panelErrors: [], growattCloud: cloud, homewizard: { status: () => ({}) }, weather: { status: () => ({}) } });
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/intern/api/v1/pv/corrections`)).json();
  assert.equal(status.latest.time, '09:15');
  assert.equal(status.latest.factor, 0.81);
  assert.equal(status.latest.sampling.used_samples, 2);
  assert.deepEqual(status.latest.sampling.ignored_times, [iso(target)]);
  const forecast = await (await fetch(`${base}/intern/api/v1/forecast?hours=3`)).json();
  assert.ok(forecast.slots.every((slot) => slot.power_w === 1000 && slot.automatic_correction_factor === 1));
  const previous = globalThis.document, nodes = new Map();
  globalThis.document = { createElement: () => ({ textContent: '' }), getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } });
    return nodes.get(id);
  } };
  try {
    renderGrowattCloud(cloud.status());
    assert.match(nodes.get('cloud-interval').textContent, /:00 · :05 · :10/);
    assert.match(nodes.get('cloud-correction').textContent, /09:15 · 2\/3 metingen · 1 uitschieter genegeerd/);
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
  assert.equal(f.repository.countCalls('2026-10-18'), 0);
});

test('herstart leert direct uit opgeslagen afwijkende meetklokken en bewaart correctie en wachtstatus buiten de logs', async (t) => {
  const f = fixture(t, { automatic: { sample_tolerance_seconds: 90 } });
  f.trio([800, 2000, 820], { skew: serials.map(() => -134000) });
  const learner = createPvCorrectionLearner({ ...f, panelErrors: [], clock: () => f.now });
  const result = learner.learn();
  assert.equal(result.status, 'updated'); assert.equal(result.factor, 0.81);
  assert.equal(f.pattern().length, 1); assert.equal(JSON.parse(f.pattern()[0].sampling_json).used_samples, 2);
  const cached = f.repository.pv(target - quarter, target);
  assert.ok(cached.length > 0); assert.ok(cached.every((row) => row.correction_factor === 0.81));
  f.repository.clearGrowattDiagnostics(); f.repository.setLogging('growatt', false);
  assert.equal(f.repository.diagnosticState('growatt', 'pv_correction').status, 'updated');
  const server = startHttpServer({ ...f, panelErrors: [], weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening'); t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const corrections = await (await fetch(`${base}/intern/api/v1/pv/corrections`)).json();
  assert.equal(corrections.status, 'active'); assert.equal(corrections.last_attempt.status, 'updated');
  assert.equal(corrections.sample_tolerance_seconds, 150);
  const table = await (await fetch(`${base}/intern/api/v1/database/rows?table=pv_block_corrections`)).json();
  assert.equal(table.total_rows, 1); assert.equal(table.rows[0][table.columns.findIndex((column) => column.name === 'factor')], 0.81);
  const display = {};
  renderPvCorrection(display, corrections); assert.match(display.textContent, /Correctie -19%/); assert.match(display.textContent, /2\/3 metingen/);
  assert.equal((await fetch(`${base}/pv-correction-status.js`)).status, 200);
  assert.equal(learner.learn().status, 'unchanged'); assert.equal(f.pattern().length, 1);
});

test('nieuwe weerdata hervat een eerder geblokkeerde correctie direct en pas na de weertransactie', async (t) => {
  const f = fixture(t, { weather: false });
  f.trio([800, 820, 840], { skew: serials.map(() => 134000) });
  const learner = createPvCorrectionLearner({ ...f, panelErrors: [], clock: () => f.now });
  assert.equal(learner.learn().status, 'forecast_unavailable'); assert.equal(f.pattern().length, 0);
  let callbacks = 0;
  const weather = createWeatherScheduler({ ...f, panelErrors: [], clock: () => f.now,
    source: async () => ({ rows: [{ source: 'open-meteo', model: 'icon_d2', start_ms: target - quarter, end_ms: target,
      ghi: 125, dni: 0, dhi: 125, fetched_ms: f.now }, { source: 'open-meteo', model: 'icon_d2', start_ms: target, end_ms: target + quarter,
      ghi: 125, dni: 0, dhi: 125, fetched_ms: f.now }], sun: [] }),
    onForecast: (at) => { callbacks++; assert.equal(at, f.now); assert.equal(learner.learn(null, at).status, 'updated'); } });
  assert.equal((await weather.refresh()).reason, 'ok'); assert.equal(callbacks, 1);
  assert.equal(f.pattern()[0].factor, 0.82); assert.equal(f.repository.diagnosticState('growatt', 'pv_correction').status, 'updated');
  assert.equal(weather.status().last_error, null);
});

test('wachtredenen zijn zichtbaar op het dashboard, inclusief het aantal ontvangen omvormers per moment', (t) => {
  const f = fixture(t), learner = createPvCorrectionLearner({ ...f, panelErrors: [], clock: () => f.now }), display = {};
  assert.equal(learner.learn().status, 'incomplete');
  renderPvCorrection(display, createPvForecastModel(f.repository, f.settings, f.panels, f.now).status());
  assert.match(display.textContent, /wachten op omvormers \(0\/4\)/);
  f.add(target - five, 800); f.add(target, 820, { omit: [3] }); f.add(target + five, 840);
  assert.equal(learner.learn().status, 'waiting_for_samples');
  renderPvCorrection(display, createPvForecastModel(f.repository, f.settings, f.panels, f.now).status());
  assert.match(display.textContent, /wachten op meetpunten \(2\/3\)/); assert.match(display.title, /09:15: 3\/4 omvormers · onvolledig/);
  assert.equal(f.pattern().length, 0);
  f.add(target, 820, { received: f.now + 1 });
  assert.equal(learner.learn().status, 'updated'); assert.equal(f.pattern().length, 1);
  renderPvCorrection(display, createPvForecastModel(f.repository, f.settings, f.panels, f.now).status());
  assert.match(display.textContent, /Correctie -18%/);
});

test('strenge handmatige tijdsmarge, verouderde voorspelling en uitgeschakelde correctie worden verklaard zonder ongeldige correctierij', (t) => {
  for (const reason of ['waiting_for_samples', 'forecast_stale', 'disabled', 'configuration_incomplete']) {
    const f = fixture(t, { automatic: reason === 'waiting_for_samples' ? { sample_tolerance_seconds: 60 } : reason === 'disabled' ? { enabled: false } : {} });
    f.trio([800, 820, 840], { skew: serials.map(() => -134000) });
    if (reason === 'forecast_stale') f.settings.weather.stale_after_hours = 0.01;
    const learner = createPvCorrectionLearner({ ...f, panelErrors: reason === 'configuration_incomplete' ? ['paneelverdeling ontbreekt'] : [], clock: () => f.now });
    assert.equal(learner.learn().status, reason); assert.equal(f.pattern().length, 0);
    const display = {}; renderPvCorrection(display, createPvForecastModel(f.repository, f.settings, f.panels, f.now).status());
    assert.ok(display.textContent.length > 15); assert.doesNotMatch(display.textContent, /undefined|NaN/);
    if (reason === 'waiting_for_samples') {
      assert.match(display.title, /12 metingen buiten de ingestelde tijdsmarge/);
      assert.equal(f.repository.diagnosticState('growatt', 'pv_correction').diagnostics.rejected_timing, 12);
    }
    if (reason === 'forecast_stale') assert.match(display.textContent, /weersvoorspelling te oud/);
    if (reason === 'disabled') assert.match(display.textContent, /uitgeschakeld/);
  }
});

test('een mislukte correctie wordt bewaard en een nieuwe paneelconfiguratie neemt geen wachtreden van een ander model over', (t) => {
  const f = fixture(t); f.trio();
  const repository = { ...f.repository, savePvBlockCorrection() { throw new Error('Testfout tijdens opslaan'); } };
  const learner = createPvCorrectionLearner({ ...f, repository, panelErrors: [], clock: () => f.now });
  assert.equal(learner.learn().status, 'error'); assert.equal(f.pattern().length, 0);
  const display = {}; renderPvCorrection(display, createPvForecastModel(f.repository, f.settings, f.panels, f.now).status());
  assert.match(display.textContent, /fout bij berekenen/); assert.match(display.title, /Testfout tijdens opslaan/);
  const changed = { ...f.panels, groups: f.panels.groups.map((group) => ({ ...group, wp_per_panel: 450 })) };
  assert.equal(createPvForecastModel(f.repository, f.settings, changed, f.now).status().last_attempt, null);
});
