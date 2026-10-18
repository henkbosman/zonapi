import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfiguration } from '../src/config/load.js';
import { normalizeOpenMeteo } from '../src/weather/open-meteo-client.js';
import { forecastDayForDate } from '../src/api/forecast-days.js';
import { productionSeries } from '../src/api/production-series.js';
import { startHttpServer } from '../src/api/http-server.js';
import { createGrowattCloudClient } from '../src/growatt/cloud/client.js';
import { growattCloudConfig } from '../src/growatt/cloud/config.js';
import { createGrowattCloudPoller } from '../src/growatt/cloud/poller.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { drawProductionChart } from '../public/dashboard-production-chart.js';
import { clockAxisTicks } from '../public/production-chart-series.js';
import { renderGrowattCloud } from '../public/growatt-cloud.js';

const quarter = 900000, minute = 60000;
const at = (time) => Date.parse(`2026-10-17T${time}Z`);
const iso = (ms) => new Date(ms).toISOString();
const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];

/** Bouwt een controleerbare SVG-node; input: tagnaam; output: node met attributen, tekst en gebeurtenissen. */
function element(tagName) {
  return { tagName, attributes: {}, children: [], listeners: {}, textContent: '', clientWidth: 850,
    setAttribute(name, value) { this.attributes[name] = String(value); }, append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }, addEventListener(name, listener) { this.listeners[name] = listener; },
    getBoundingClientRect() { return { left: 0, width: 850 }; } };
}

/** Verbindt de echte renderers met testnodes; input: testcontext; output: dashboardcontainer en Growatt-nodes. */
function dom(t) {
  const previous = globalThis.document, nodes = new Map();
  globalThis.document = { createElement: element, createElementNS: (_, tag) => element(tag), getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, element('div'));
    return nodes.get(id);
  } };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return { container: element('div'), nodes };
}

/** Bouwt een installatie zonder externe verbinding; input: testcontext; output: opslag, instellingen, panelen en zonuren. */
function fixture(t) {
  const { settings } = loadConfiguration();
  settings.http = { host: '127.0.0.1', port: 0 }; settings.location = { latitude: 52, longitude: 5 };
  settings.growatt = { ...settings.growatt, production_source: 'cloud', cloud: { token: 'test-clock-token', poll_seconds: 300 } };
  const panels = { inverters: serials.map((serial, index) => ({ id: `mic-${index}`, serial, ac_limit_w: 1000 })),
    groups: serials.map((_, index) => ({ id: `vlak-${index}`, inverter_id: `mic-${index}`, count: 1, wp_per_panel: 1000, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 })) };
  const db = openDatabase(':memory:'), repository = createRepository(db);
  const sunrise = '2026-10-17T12:58:19Z', sunset = '2026-10-17T14:03:17Z';
  repository.saveSun('2026-10-17', Date.parse(sunrise), Date.parse(sunset), 'test', at('13:00:00'));
  t.after(() => db.close());
  return { settings, panels, repository, sunrise, sunset };
}

/** Maakt een Open-Meteo-antwoord met native kwartieren plus uurterugval; input: geen; output: bronklokken op tijdvakeinden. */
function payload() {
  const series = (times, values, model) => ({ time: times.map((time) => at(time) / 1000),
    [`shortwave_radiation_${model}`]: values, [`direct_normal_irradiance_${model}`]: values.map(() => 0), [`diffuse_radiation_${model}`]: values });
  return { hourly: series(['13:00:00', '14:00:00', '15:00:00'], [50, 80, 40], 'best_match'),
    minutely_15: series(['12:45:00', '13:00:00', '13:15:00', '13:30:00'], [10, 20, 30, 40], 'icon_d2') };
}

test('Open-Meteo-klok blijft van JSON via SQLite en dag-API tot SVG op kwartieren, inclusief uurterugval', (t) => {
  const f = fixture(t), view = dom(t), normalized = normalizeOpenMeteo(payload(), at('12:00:00'));
  for (const row of normalized.rows) f.repository.saveForecast(row);
  const before = f.repository.forecastCandidates(0, Infinity).map((row) => ({ ...row }));
  const day = forecastDayForDate(f.repository, f.settings, f.panels, [], {}, at('13:35:00'));
  assert.equal(day.status, 'ok');
  for (const slot of day.slots) {
    assert.equal(slot.time, slot.end);
    assert.equal(slot.time_basis, 'preceding_interval_mean');
    assert.equal(Date.parse(slot.time) % quarter, 0);
  }
  const quarterSlot = day.slots.find((slot) => slot.time === iso(at('13:15:00')));
  assert.equal(quarterSlot.start, iso(at('13:00:00')));
  assert.equal(quarterSlot.ghi_w_m2, 30);
  const fallback = day.slots.find((slot) => slot.end === iso(at('14:00:00')));
  assert.equal(fallback.start, iso(at('13:30:00')));
  assert.equal(fallback.sample_start, iso(at('13:00:00')));
  assert.equal(fallback.source_resolution_minutes, 60);
  drawProductionChart(view.container, { ...day, points: [] }, day.slots);
  const svg = view.container.children[0], dots = svg.children.filter((node) => node.attributes['data-series'] === 'forecast');
  assert.deepEqual(dots.map((dot) => dot.attributes['data-time']), ['13:00:00', '13:15:00', '13:30:00', '14:00:00'].map((time) => iso(at(time))));
  assert.ok(dots.every((dot) => Date.parse(dot.attributes['data-time']) % quarter === 0));
  const selected = dots.find((dot) => dot.attributes['data-time'] === quarterSlot.time);
  assert.match(selected.children[0].textContent, /15:15 · 120 W · Correctie 0% · Gemiddelde 15:00–15:15/);
  const line = svg.children.find((node) => node.tagName === 'path');
  assert.match(line.attributes.d, /^M52\.0,/);
  assert.match(line.attributes.d, /L832\.0,/);
  assert.deepEqual(f.repository.forecastCandidates(0, Infinity).map((row) => ({ ...row })), before);
});

test('Growatt kan op het kwartier worden opgevraagd terwijl de echte blauwe meetpunten minuten eerder liggen', async (t) => {
  const f = fixture(t), view = dom(t);
  let now = at('13:07:00');
  t.mock.method(Date, 'now', () => now);
  const starts = [];
  const client = createGrowattCloudClient(growattCloudConfig(f.settings), 'test-clock-token', {
    clock: () => now, pause: async (ms) => { now += ms; }, onCall: f.repository.saveGrowattCloudCall,
    fetcher: async (_, options) => {
      const serial = new URLSearchParams(options.body).get('deviceSn'), index = serials.indexOf(serial);
      starts.push(now); now += 250;
      return Response.json({ code: 0, data: { min: [{ serialNum: serial, time: iso(at('13:02:46') + index * 5000),
        calendar: now + 6 * 3600000, pac: 250, eacToday: 1, eacTotal: 100 }] } });
    }
  });
  const cloud = createGrowattCloudPoller({ ...f, clock: () => now, environment: {}, client });
  now = at('13:15:00') + 17;
  assert.equal((await cloud.poll()).reason, 'ok');
  const state = cloud.status();
  assert.equal(state.last_scheduled, iso(at('13:15:00')));
  assert.equal(state.last_attempt, iso(at('13:15:00') + 17));
  assert.equal(state.schedule_delay_ms, 17);
  assert.equal(state.next_fetch, iso(at('13:20:00')));
  assert.deepEqual(starts.map((ms) => ms - at('13:15:00')), [17, 1117, 2217, 3317]);
  assert.deepEqual(state.last_measurements.map((row) => row.requested_at), starts.map(iso));
  assert.equal(state.last_measurements[0].measured_at, iso(at('13:02:46')));
  assert.equal(state.last_measurements[0].received_at, iso(starts[0] + 250));
  renderGrowattCloud(state);
  assert.equal(view.nodes.get('cloud-delay').textContent, '17 ms');
  assert.equal(view.nodes.has('cloud-measurement-times'), false);
  const server = startHttpServer({ ...f, panelErrors: [], growattCloud: cloud,
    weather: { status: () => ({ sunrise: f.sunrise, sunset: f.sunset }) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await cloud.stop(); });
  const day = await (await fetch(`http://127.0.0.1:${server.address().port}/api/v1/production/day`)).json();
  assert.equal(day.points.length, 1);
  assert.equal(day.points[0].time, iso(at('13:03:01')));
  assert.equal(day.points[0].measured_from, iso(at('13:02:46')));
  assert.equal(day.points[0].measurement_span_seconds, 15);
  drawProductionChart(view.container, day, []);
  const svg = view.container.children[0], dot = svg.children.find((node) => node.tagName === 'circle');
  assert.equal(dot.attributes['data-time'], iso(at('13:03:01')));
  assert.match(dot.children[0].textContent, /15:03:01.*Metingen 15:02:46–15:03:01/);
  const target = svg.children.find((node) => node.attributes.role === 'slider');
  assert.equal(target.attributes['pointer-events'], 'none');
  assert.equal(typeof svg.listeners.pointermove, 'function');
  const cursor = svg.children.find((node) => 'data-chart-cursor' in node.attributes);
  svg.listeners.pointermove({ clientX: Number(dot.attributes.cx) });
  assert.equal(cursor.children[2].textContent, '15:03:01');
  await cloud.stop();
  const restored = createGrowattCloudPoller({ ...f, clock: () => now, environment: {}, client });
  assert.deepEqual(restored.status().last_measurements, state.last_measurements);
  assert.equal((await restored.poll()).reason, 'interval');
});

test('gedeeltelijke omvormerrondes krijgen geen volledig blauw punt met overgenomen waarden van het vorige kwartier', () => {
  const first = at('13:00:00');
  const rows = serials.map((serial, index) => ({ serial, measured_ms: first + index * 5000, received_ms: first + 20000, power_w: 100, source: 'cloud' }));
  rows.push(...serials.slice(0, 3).map((serial, index) => ({ serial, measured_ms: first + quarter + index * 5000, received_ms: first + quarter + 20000, power_w: 200, source: 'cloud' })));
  const evaluate = () => productionSeries(rows, first + 2 * quarter, null, null, 4, 12, serials, 900);
  assert.deepEqual(evaluate().map((point) => point.power_w), [400]);
  rows.push({ serial: serials[3], measured_ms: first + quarter + 15000, received_ms: first + quarter + 20000, power_w: 200, source: 'cloud' });
  assert.deepEqual(evaluate().map((point) => point.power_w), [400, 800]);
});

test('tijdlabels en kwartierlijnen volgen de klok bij afwijkende zonuren, smalle grafieken en zomer-/wintertijd', () => {
  for (const start of [at('06:03:19'), Date.parse('2026-03-29T00:53:19Z'), Date.parse('2026-10-25T00:53:19Z')]) {
    const end = start + 9 * 3600000 + 43 * minute;
    for (const width of [210, 780, 1150]) {
      const ticks = clockAxisTicks(start, end, width);
      assert.equal(ticks[0], start); assert.equal(ticks.at(-1), end);
      assert.ok(ticks.slice(1, -1).every((time) => time % quarter === 0));
      assert.equal(new Set(ticks).size, ticks.length);
      assert.ok(ticks.every((time, index) => !index || time > ticks[index - 1]));
    }
  }
});
