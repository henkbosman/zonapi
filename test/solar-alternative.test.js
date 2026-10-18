import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration } from '../src/config/load.js';
import { startHttpServer } from '../src/api/http-server.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { advise } from '../src/appliances/start-advice.js';
import { dailyAdvice } from '../src/appliances/daily-advice.js';
import { renderDailyAdvice } from '../public/dashboard-daily-advice.js';

const minute = 60000, hour = 60 * minute, quarter = 15 * minute;
const at = (time) => Date.parse(`2026-10-17T${time}:00Z`);

/** Maakt een apparaat met bekende fasen; input: id en [minuten,watt]-paren; output: profiel. */
function profile(id = 'wasmachine', steps = [[15, 1000]]) {
  return { id, name: id, duration_minutes: steps.reduce((total, step) => total + step[0], 0),
    steps: steps.map(([duration_minutes, power_w]) => ({ duration_minutes, power_w })) };
}

/** Bouwt een kwartierprognose met direct controleerbare PV-watt; input: vermogensfunctie en klok; output: adviescontext, weer en lokale zontijden. */
function fixture(power, now = at('08:00')) {
  const from = at('06:00'), weather = [];
  for (let start = from; start < from + 3 * 86400000; start += quarter) {
    weather.push({ start_ms: start, end_ms: start + quarter, fetched_ms: now, power_w: power(start) });
  }
  return { weather, repository: { getSun: (day) => ({ sunrise_ms: Date.parse(`${day}T06:00:00Z`), sunset_ms: Date.parse(`${day}T16:00:00Z`) }) },
    context: { now, settings: { weather: { forecast_days: 2, stale_after_hours: 4 },
      advice: { search_hours: 5, start_step_minutes: 5, min_solar_share: 1, reserve_w: 0 } }, panels: {}, panelErrors: [],
    latitude: 52, longitude: 5, baseload: { power_w: 0, source: 'config' }, pvModel: { estimate: (row) => ({ power_w: row.power_w }) } } };
}

/** Bouwt een kleine DOM voor zichtbare dashboardadviezen; input: tag; output: testnode. */
function element(tagName) {
  return { tagName, textContent: '', children: [], className: '', title: '',
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; }, setAttribute() {} };
}

/** Verzamelt zichtbare tekst, inclusief de alternatiefregel; input: node; output: tekst. */
function text(node) { return [node.textContent, ...node.children.map(text)].filter(Boolean).join(' '); }

/** Verbindt de echte dashboardrenderer aan testnodes; input: testcontext; output: container en renderfunctie. */
function dashboard(t) {
  const previous = globalThis.document;
  globalThis.document = { createElement: element };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const container = element('div');
  return { container, render(profiles, daily) { renderDailyAdvice(container, profiles, daily); return text(container); } };
}

test('beste zonmoment volgt de hele verbruikscyclus en kan vóór de hoogste opwek liggen', () => {
  const f = fixture((start) => start >= at('11:00') && start < at('12:00') ? 900 : start >= at('12:00') && start < at('13:00') ? 600 : 100);
  const appliance = profile('wasmachine', [[60, 100], [60, 1000]]);
  const result = advise(appliance, f.weather, f.context);
  assert.equal(result.status, 'ok');
  assert.equal(result.earliest_start, null);
  assert.equal(result.can_start_now, false);
  assert.equal(result.best_start, new Date(at('10:00')).toISOString());
  assert.equal(result.best.energy_wh, 1100);
  assert.equal(result.best.solar_wh, 1000);
  assert.equal(result.best.solar_share_percent, 90.9);
});

test('het minimumadvies blijft bestaan naast het latere beste zonmoment en gelijke opties kiezen de vroegste', () => {
  const f = fixture((start) => start >= at('11:00') ? 900 : start >= at('10:00') ? 700 : 0);
  f.context.settings.advice.min_solar_share = 0.7;
  const result = advise(profile(), f.weather, f.context);
  assert.equal(result.earliest_start, new Date(at('10:00')).toISOString());
  assert.equal(result.earliest.solar_share_percent, 70);
  assert.equal(result.best_start, new Date(at('11:00')).toISOString());
  assert.equal(result.best.solar_share_percent, 90);
  const equal = fixture(() => 650, at('08:03'));
  assert.equal(advise(profile(), equal.weather, equal.context).best_start, new Date(at('08:03')).toISOString());
});

test('kleine energieverschillen en de minimumgrens worden vóór afronding vergeleken', () => {
  const f = fixture((start) => start < at('08:15') ? 649.71 : 649.74);
  f.context.settings.advice.search_hours = 0.25;
  f.context.settings.advice.min_solar_share = 0.64972;
  f.context.settings.advice.start_step_minutes = 15;
  const result = advise(profile(), f.weather, f.context);
  assert.equal(result.now.solar_share_percent, 65);
  assert.equal(result.best.solar_share_percent, 65);
  assert.equal(result.now.solar_wh, result.best.solar_wh);
  assert.equal(result.best_start, new Date(at('08:15')).toISOString());
  assert.equal(result.earliest_start, result.best_start);
  assert.equal(result.can_start_now, false);
});

test('99,96 procent wordt geen volledig zonneadvies door afronding', () => {
  const f = fixture(() => 999.6), result = advise(profile(), f.weather, f.context);
  assert.equal(result.best.solar_share, 0.9996);
  assert.equal(result.best.solar_share_percent, 99.9);
  assert.equal(result.earliest_start, null);
  assert.equal(result.can_start_now, false);
});

test('ieder apparaat en iedere dag krijgt een eigen beste zonmoment binnen de resterende zonuren', (t) => {
  const f = fixture((start) => {
    const day = new Date(start).getUTCDate();
    const peak = Date.parse(`2026-10-${day}T${day === 17 ? '09' : '11'}:00:00Z`);
    return start >= peak && start < peak + hour ? day === 17 ? 600 : 800 : 100;
  });
  const profiles = [profile(), profile('vaatwasser', [[60, 100], [60, 1000]])];
  const result = dailyAdvice(profiles, f.weather, f.context, f.repository);
  assert.deepEqual(result.days.map((day) => day.appliances.map((item) => item.best_start)), [
    ['2026-10-17T09:00:00.000Z', '2026-10-17T08:00:00.000Z'],
    ['2026-10-18T11:00:00.000Z', '2026-10-18T10:00:00.000Z']
  ]);
  for (const day of result.days) for (const item of day.appliances) {
    assert.equal(item.status, 'ok');
    assert.equal(item.earliest_start, null);
    assert.ok(Date.parse(item.best_start) >= Math.max(f.context.now, Date.parse(day.sunrise)));
    assert.ok(Date.parse(item.best_start) + item.duration_minutes * minute <= Date.parse(day.sunset));
  }
  const ui = dashboard(t), rendered = ui.render(profiles, result);
  assert.match(rendered, /11:00 Meeste zon · 60%/);
  assert.match(rendered, /13:00 Meeste zon · 80%/);
  assert.doesNotMatch(rendered, /Te weinig zon/);
});

test('het dashboard toont beide tijden bij een lager ingesteld minimum, zonder hetzelfde tijdstip te herhalen', (t) => {
  const f = fixture((start) => start >= at('11:00') ? 900 : start >= at('10:00') ? 700 : 0);
  f.context.settings.advice.min_solar_share = 0.7;
  const appliance = profile(), result = dailyAdvice([appliance], f.weather, f.context, f.repository), ui = dashboard(t);
  assert.match(ui.render([appliance], result), /12:00 Meeste zon: 13:00 · 90%/);
  const first = result.days[0].appliances[0];
  first.earliest_start = first.best_start; first.earliest = first.best;
  assert.match(ui.render([appliance], result), /13:00 Meeste zon · 90%/);
});

test('bij volledige zonnedekking, nul zon, ontbrekende of ongeldige data wordt geen gedeeltelijk alternatief getoond', (t) => {
  const ui = dashboard(t), appliance = profile();
  for (const power of [0, 1000]) {
    const f = fixture(() => power), result = dailyAdvice([appliance], f.weather, f.context, f.repository);
    const rendered = ui.render([appliance], result);
    assert.doesNotMatch(rendered, /Meeste zon/);
    if (!power) assert.match(rendered, /Te weinig zon/);
  }
  const f = fixture(() => 600);
  for (const status of ['stale', 'forecast_incomplete', 'forecast_unavailable', 'configuration_incomplete', 'insufficient_baseload', 'no_daylight_window']) {
    const result = dailyAdvice([appliance], f.weather, f.context, f.repository);
    for (const day of result.days) day.appliances[0].status = status;
    assert.doesNotMatch(ui.render([appliance], result), /Meeste zon/);
  }
  const missing = f.weather.filter((row) => row.start_ms !== at('12:00'));
  const partial = dailyAdvice([appliance], missing, f.context, f.repository);
  assert.equal(partial.days[0].appliances[0].status, 'forecast_incomplete');
  ui.render([appliance], partial);
  assert.doesNotMatch(text(ui.container.children[0].children.at(-1).children[0]), /Meeste zon/);
});

test('een actief apparaat houdt vandaag Bezig terwijl volgende dagen wel het beste zonmoment tonen', (t) => {
  const f = fixture(() => 600), appliance = profile();
  const result = dailyAdvice([appliance], f.weather, f.context, f.repository), ui = dashboard(t);
  appliance.activity = { configured: true, state: 'running', running: true, power_w: 500, started_at: new Date(at('07:55')).toISOString() };
  ui.render([appliance], result);
  const rows = ui.container.children[0].children.at(-1).children;
  assert.match(text(rows[0]), /Bezig/);
  assert.doesNotMatch(text(rows[0]), /Meeste zon/);
  assert.match(text(rows[1]), /Meeste zon · 60%/);
});

test('API en dashboard gebruiken dezelfde beste gedeeltelijke cyclus uit de cache zonder extra bronverzoeken', async (t) => {
  const now = at('08:00'), appliance = profile('wasmachine', [[60, 1000]]);
  t.mock.method(Date, 'now', () => now);
  const { settings } = loadConfiguration();
  settings.http = { host: '127.0.0.1', port: 0 };
  settings.location = { latitude: 52, longitude: 5 };
  settings.advice = { ...settings.advice, min_solar_share: 1, baseload_w: 100, reserve_w: 100, search_hours: 8 };
  const panels = { inverters: [{ id: 'test', serial: 'INV0000001', ac_limit_w: 2000 }],
    groups: [{ id: 'vlak', inverter_id: 'test', count: 1, wp_per_panel: 1000, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 }] };
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-solar-alternative-'));
  const db = openDatabase(':memory:'), repository = createRepository(db);
  writeFileSync(join(folder, 'wasmachine.json'), JSON.stringify(appliance));
  for (let start = at('06:00'); start < at('06:00') + 4 * 86400000; start += quarter) {
    const power = new Date(start).getUTCHours() === 11 ? 800 : 300;
    repository.saveForecast({ source: 'test', model: 'test', start_ms: start, end_ms: start + quarter, ghi: power, dni: 0, dhi: power, fetched_ms: now });
  }
  for (const day of [17, 18, 19]) repository.saveSun(`2026-10-${day}`, Date.parse(`2026-10-${day}T06:00:00Z`), Date.parse(`2026-10-${day}T16:00:00Z`), 'test', now);
  const server = startHttpServer({ settings, panels, panelErrors: [], repository, profilesDirectory: folder,
    weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const daily = await (await fetch(`${base}/intern/api/v1/appliances/daily`)).json();
  const single = await (await fetch(`${base}/intern/api/v1/appliances/wasmachine/advice`)).json();
  const first = daily.days[0].appliances[0];
  assert.equal(first.status, 'ok');
  assert.equal(first.earliest_start, null);
  assert.equal(first.best_start, new Date(at('11:00')).toISOString());
  assert.equal(first.best.solar_share, 0.6);
  assert.deepEqual(first.best, single.best);
  const ui = dashboard(t), rendered = ui.render([appliance], daily);
  assert.match(rendered, /13:00 Meeste zon · 60%/);
  assert.equal(repository.countCalls('2026-10-17'), 0);
  assert.equal(repository.currentCloudInverters().length, 0);
  assert.equal(repository.currentMeters().length, 0);
});
