import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { correctionModelKey } from '../src/pv/correction-key.js';
import { createPvForecastModel } from '../src/pv/forecast-model.js';
import { createPvCorrectionLearner } from '../src/pv/correction-learner.js';
import { learnPvCorrection } from '../src/pv/learn-correction.js';
import { refreshPvForecast } from '../src/pv/refresh-forecast.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { addCalendarDays, localDayRange } from '../src/weather/local-calendar.js';
import { localDay } from '../src/weather/local-day.js';
import { startHttpServer } from '../src/api/http-server.js';
import { clearSkyBounds, weatherLocationKey } from '../src/weather/clear-sky.js';

const minute = 60000, five = 5 * minute, quarter = 15 * minute, day = 86400000;
const target = Date.parse('2026-10-18T08:15:00Z');
const iso = (ms) => new Date(ms).toISOString();

/** Bouwt opeenvolgende Nederlandse dagen met eigen basisvermogen en echte SQLite-opslag; input: testcontext en opties; output: klok, meet- en voorspelhelpers. */
function fixture(t, { center = target, path = ':memory:' } = {}) {
  const { settings } = loadConfiguration();
  settings.location = { latitude: 52, longitude: 5 };
  settings.http = { host: '127.0.0.1', port: 0 };
  settings.growatt = { ...settings.growatt, expected_inverters: 1, production_source: 'cloud' };
  settings.advice = { ...settings.advice, baseload_w: 100, reserve_w: 100, min_solar_share: 1 };
  const panels = { expected_panel_count: 5, inverters: [{ id: 'mic', serial: 'TEST123456', ac_limit_w: 4000 }],
    groups: [{ id: 'vlak', inverter_id: 'mic', count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 }] };
  const f = { settings, panels, now: center + 10 * minute, db: openDatabase(path), firstDay: localDay(center - quarter) };
  f.repository = createRepository(f.db);
  f.model = () => createPvForecastModel(f.repository, settings, panels, f.now);
  f.blocks = () => f.repository.pvBlockCorrections(correctionModelKey(settings, panels));
  f.saveDay = (offset, power) => {
    const date = addCalendarDays(f.firstDay, offset), range = localDayRange(date);
    f.repository.saveSun(date, range.start_ms + 6 * 3600000, range.start_ms + 18 * 3600000, 'test', f.now);
    for (let start = range.start_ms; start < range.end_ms; start += quarter) f.repository.saveForecast({
      source: 'open-meteo', model: 'icon_d2', start_ms: start, end_ms: start + quarter,
      ghi: power / 2, dni: 0, dhi: power / 2, fetched_ms: f.now });
  };
  [1000, 1500, 2000, 1000].forEach((power, offset) => f.saveDay(offset, power));
  f.freshen = () => f.db.prepare('UPDATE forecast SET fetched_ms=?').run(f.now);
  f.value = (end) => {
    const model = f.model(), row = model.prepare(f.repository.forecast(end - 1, end)).find((item) => item.end_ms === end);
    assert.ok(row, 'Voorspelblok ontbreekt'); return model.estimate(row);
  };
  f.direct = (end, power) => {
    f.now = Math.max(f.now, end + 10 * minute);
    return learnPvCorrection(f.repository, settings, panels, [], [{ serial: 'TEST123456', source: 'cloud', power_w: power,
      measured_ms: end + five + 1000, received_ms: f.now }], f.now, { target_ms: end, defer: false });
  };
  f.learner = createPvCorrectionLearner({ settings, panels, panelErrors: [], repository: f.repository, clock: () => f.now });
  f.approve = (end) => {
    const bounds = clearSkyBounds(end);
    for (let time = bounds.from; time <= bounds.until; time += 3600000) f.repository.saveWeatherCondition(weatherLocationKey(settings.location), {
      source: 'open-meteo', model: 'best_match', time_ms: time, cloud_cover: 0, weather_code: 0, fetched_ms: f.now });
    return f.learner.learn();
  };
  f.sample = (time, power, received = time + 1000) => {
    f.now = Math.max(f.now, received);
    f.repository.saveCloudInverter({ serial: 'TEST123456', source: 'cloud', measured_ms: time, received_ms: received,
      power_w: power, energy_today_kwh: 1, energy_total_kwh: 100 });
    return f.learner.learn();
  };
  t.after(() => f.db.close());
  return f;
}

test('de correctie van morgen blijft bij de Nederlandse dagovergang gelden voor vandaag op de eigen dagbasis', (t) => {
  const f = fixture(t); assert.equal(f.direct(target, 600).factor, 0.6);
  const todayEnd = target + day;
  assert.equal(f.value(todayEnd).power_w, 900);
  f.now = localDayRange('2026-10-19').start_ms + minute;
  assert.equal(f.value(todayEnd).base_power_w, 1500);
  assert.equal(f.value(todayEnd).power_w, 900);
  assert.equal(f.value(todayEnd).correction_source, 'same_clock_quarter');
  assert.equal(f.value(todayEnd).correction_reference_end, iso(target));
  assert.equal(f.value(todayEnd + quarter).power_w, 1500);
  assert.equal(f.value(todayEnd + day).power_w, 1200);
  assert.equal(f.model().status().learned_blocks_today, 0);
  assert.equal(f.blocks().length, 1, 'Een overgenomen factor is geen nieuw gemeten correctieblok');
});

test('vandaag gebruikt dezelfde correcties in de openbare grafiek, interne grafieken en programma-adviezen', async (t) => {
  const f = fixture(t); f.direct(target, 400);
  f.now = target + day - 15 * minute; f.freshen();
  const end = target + day, date = localDay(f.now);
  f.repository.saveSun(date, end - quarter, end + quarter, 'test', f.now);
  const profilesDirectory = mkdtempSync(join(tmpdir(), 'zonapi-today-programs-'));
  t.after(() => rmSync(profilesDirectory, { recursive: true, force: true }));
  writeFileSync(join(profilesDirectory, 'apparaat.json'), JSON.stringify({ id: 'apparaat', name: 'Apparaat', programs: [
    { id: 'eco', name: 'Eco', steps: [{ duration_minutes: 15, power_w: 800 }] },
    { id: 'snel', name: 'Snel', steps: [{ duration_minutes: 15, power_w: 1600 }] }
  ] }));
  t.mock.method(Date, 'now', () => f.now);
  const server = startHttpServer({ ...f, profilesDirectory, panelErrors: [], weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening'); t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    assert.equal(response.status, 200); return response.json();
  };
  const snapshot = await get('/api/v1/dashboard');
  const graphs = await get('/intern/api/v1/forecast/days');
  const today = await get('/intern/api/v1/forecast/day');
  for (const graph of [snapshot.forecasts.days[0], graphs.days[0], today]) {
    const slot = graph.slots.find((row) => Date.parse(row.end) === end);
    assert.equal(slot.base_power_w, 1500); assert.equal(slot.power_w, 600);
    assert.equal(slot.automatic_correction_factor, 0.4); assert.equal(slot.correction_reference_end, iso(target));
    assert.equal(graph.slots.find((row) => Date.parse(row.end) === end + quarter).power_w, 1500);
  }
  for (const response of [snapshot.daily, await get('/intern/api/v1/appliances/daily')]) {
    const [eco, snel] = response.days[0].appliances[0].programs;
    assert.equal(eco.earliest_start, iso(end));
    assert.equal(eco.earliest.solar_share_percent, 100);
    assert.equal(snel.earliest_start, null);
    assert.equal(snel.best_start, iso(end)); assert.equal(snel.best.solar_share_percent, 81.3);
  }
  const advice = await get('/intern/api/v1/appliances/apparaat/advice?program=eco');
  assert.equal(advice.earliest_start, iso(end));
});

test('echte driepuntsmetingen en heldere verwachtingen berekenen twee kwartieren iedere dag direct opnieuw zonder stapeling', (t) => {
  const f = fixture(t), scenarios = [
    [[600, 620, 640], [700, 720, 740]],
    [[750, 780, 810], [990, 1020, 1050]],
    [[1500, 1540, 1580], [1380, 1400, 1420]]
  ], expected = [[0.62, 0.72], [0.52, 0.68], [0.77, 0.7]];
  const saved = [];
  for (const [offset, quarters] of scenarios.entries()) {
    const first = target + offset * day;
    f.now = first - 10 * minute; f.freshen();
    f.approve(first + quarter);
    for (const [index, powers] of quarters.entries()) {
      const end = first + index * quarter;
      for (const [sample, power] of powers.entries()) {
        const result = f.sample(end + (sample - 1) * five, power);
        if (sample < 2) assert.equal(f.blocks().some((row) => row.end_ms === end), false);
        else {
          assert.equal(result.status, 'updated'); assert.equal(result.clear_sky.uses_forecast, true);
        }
      }
    }
    assert.ok(f.now < clearSkyBounds(first).until);
    for (const [index, powers] of quarters.entries()) {
      const end = first + index * quarter, block = { ...f.blocks().find((row) => row.end_ms === end) };
      assert.equal(block.factor, expected[offset][index]);
      assert.equal(block.measured_w, powers[1]); assert.equal(block.predicted_w, [1000, 1500, 2000][offset]);
      assert.equal(f.value(end).power_w, powers[1]); assert.equal(f.value(end).correction_source, 'block');
      assert.equal(f.learner.learn().status, 'unchanged');
      assert.deepEqual({ ...f.blocks().find((row) => row.end_ms === end) }, block);
      saved.push(block);
    }
    const status = f.model().status();
    assert.equal(status.learned_blocks_today, 2); assert.equal(status.learned_blocks, (offset + 1) * 2);
    assert.equal(status.last_attempt.status, 'unchanged');
    assert.equal(f.value(first + 2 * quarter).correction_factor, 1);
    assert.deepEqual(f.blocks().map((row) => ({ ...row })), saved);
  }
});

test('een ontbrekend meetmoment behoudt de vorige dagfactor en een later compleet drietal vervangt deze uitsluitend voor het eigen blok', (t) => {
  const f = fixture(t); f.direct(target, 600);
  const end = target + day;
  f.now = end - 10 * minute; f.freshen();
  f.sample(end - five, 900);
  const pending = f.sample(end + five, 960);
  assert.equal(pending.status, 'waiting_for_samples'); assert.equal(pending.received_samples, 2);
  assert.equal(f.value(end).power_w, 900); assert.equal(f.value(end).correction_source, 'same_clock_quarter');
  assert.equal(f.model().status().learned_blocks_today, 0);
  assert.equal(f.sample(end, 930, f.now + 1000).status, 'clear_sky_data_missing');
  const result = f.approve(end);
  assert.equal(result.status, 'updated'); assert.equal(result.factor, 0.62);
  assert.equal(f.value(end).power_w, 930); assert.equal(f.value(end).correction_source, 'block');
  assert.equal(f.value(end).correction_reference_end, iso(end));
  assert.equal(f.value(end + quarter).power_w, 1500);
  assert.equal(f.value(end + day).power_w, 1240);
  assert.equal(f.blocks()[0].factor, 0.6); assert.equal(f.blocks().length, 2);
});

test('een weerupdate gebruikt vandaag de nieuwe eigen basis en leren vergelijkt met de ongecorrigeerde voorspelling', async (t) => {
  const f = fixture(t); f.direct(target, 600);
  const end = target + day;
  f.now = end - 10 * minute;
  const source = async () => ({ sun: [], rows: [{ source: 'open-meteo', model: 'icon_d2', start_ms: end - quarter,
    end_ms: end, ghi: 1000, dni: 0, dhi: 1000, fetched_ms: f.now }] });
  const weather = createWeatherScheduler({ ...f, panelErrors: [], clock: () => f.now, source,
    onForecast: (at) => f.learner.learn(null, at) });
  assert.equal((await weather.tick()).reason, 'ok');
  assert.equal(f.value(end).base_power_w, 2000); assert.equal(f.value(end).power_w, 1200);
  const cache = f.repository.pv(end - quarter, end);
  assert.equal(cache[0].base_power_w, 2000); assert.equal(cache[0].power_w, 1200);
  f.sample(end - five, 800); f.sample(end, 820);
  assert.equal(f.sample(end + five, 840).status, 'clear_sky_data_missing');
  assert.equal(f.approve(end).factor, 0.41);
  assert.equal(f.value(end).power_w, 820);
  assert.equal(f.blocks().find((row) => row.end_ms === end).predicted_w, 2000);
});

test('volledige cacheverversing herstelt ook al verstreken blokken van vandaag en behoudt dit na een herstart', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-today-cache-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'data.sqlite'), f = fixture(t, { path }); f.direct(target, 600);
  const end = target + day;
  f.now = end + 60 * minute; f.freshen();
  f.db.prepare('UPDATE pv_forecast SET power_w=base_power_w,correction_factor=1 WHERE start_ms>=?').run(localDayRange('2026-10-19').start_ms);
  refreshPvForecast(f.repository, f.settings, f.panels, [], f.now);
  assert.equal(f.repository.pv(end - quarter, end)[0].power_w, 900);
  f.db.close(); f.db = openDatabase(path); f.repository = createRepository(f.db);
  assert.equal(f.value(end).power_w, 900);
  assert.equal(f.repository.pv(end - quarter, end)[0].correction_factor, 0.6);
  assert.equal(f.blocks().length, 1);
});

test('de twee wintertijdkwartieren van vandaag gebruiken afzonderlijke eigen metingen of uitsluitend een eerdere dag als terugval', (t) => {
  const source = Date.parse('2026-10-24T00:15:00Z'), first = Date.parse('2026-10-25T00:15:00Z'), second = first + 3600000;
  const f = fixture(t, { center: source }); f.direct(source, 600);
  f.now = first - 10 * minute; f.freshen();
  assert.equal(f.value(first).power_w, 900); assert.equal(f.value(second).power_w, 900);
  assert.equal(f.direct(first, 1200).factor, 0.8);
  assert.equal(f.value(first).power_w, 1200);
  assert.equal(f.value(second).power_w, 900, 'Een eigen correctie geldt niet voor het herhaalde uur van dezelfde dag');
  assert.equal(f.value(second).correction_reference_end, iso(source));
  assert.equal(f.direct(second, 1050).factor, 0.7);
  assert.equal(f.value(first).power_w, 1200); assert.equal(f.value(second).power_w, 1050);
  assert.equal(f.model().status().learned_blocks_today, 2);
});

test('de vorige dagcorrectie voor 23:45–00:00 geldt ook voor het laatste kwartier van vandaag', (t) => {
  const source = Date.parse('2026-10-18T22:00:00Z'), f = fixture(t, { center: source });
  f.direct(source, 600);
  assert.equal(localDay(f.now), '2026-10-19');
  const end = source + day;
  assert.equal(f.value(end).base_power_w, 1500); assert.equal(f.value(end).power_w, 900);
  assert.equal(f.value(end).correction_reference_end, iso(source));
  assert.equal(f.model().status().learned_blocks_today, 0);
});
