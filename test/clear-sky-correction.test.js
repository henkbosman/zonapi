import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { createPvCorrectionLearner } from '../src/pv/correction-learner.js';
import { correctionModelKey } from '../src/pv/correction-key.js';
import { createPvForecastModel } from '../src/pv/forecast-model.js';
import { clearSkyBounds, checkClearSky, skyCondition, weatherLocationKey } from '../src/weather/clear-sky.js';
import { normalizeOpenMeteo, forecastUrl } from '../src/weather/open-meteo-client.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { startHttpServer } from '../src/api/http-server.js';
import { renderPvCorrection } from '../public/pv-correction-status.js';
import { localDay } from '../src/weather/local-day.js';
import { localDayRange } from '../src/weather/local-calendar.js';

const minute = 60000, hour = 3600000, five = 5 * minute, quarter = 15 * minute;
const target = Date.parse('2026-10-20T07:15:00Z'); // 09:00–09:15 in Nederland.
const iso = (ms) => new Date(ms).toISOString();

/** Bouwt de echte productieleerfunctie met bewaarde bronmetingen; input: testcontext en optioneel databasepad; output: klok, heldere uurpunten en meetrondes. */
function fixture(t, path = ':memory:') {
  const { settings } = loadConfiguration();
  settings.location = { latitude: 52, longitude: 5 }; settings.http = { host: '127.0.0.1', port: 0 };
  settings.growatt.production_source = 'cloud';
  settings.advice.baseload_w = 100;
  const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];
  const panels = { expected_panel_count: 20, inverters: serials.map((serial, index) => ({ id: `mic-${index}`, serial, ac_limit_w: 2000 })),
    groups: serials.map((_, index) => ({ id: `vlak-${index}`, inverter_id: `mic-${index}`, count: 5, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 })) };
  const f = { settings, panels, now: target - 10 * minute, db: openDatabase(path) };
  f.restart = () => {
    if (f.repository) { f.db.close(); f.db = openDatabase(path); }
    f.repository = createRepository(f.db);
    f.learner = createPvCorrectionLearner({ ...f, panelErrors: [], clock: () => f.now });
  };
  f.restart();
  f.key = () => correctionModelKey(settings, panels);
  f.blocks = () => f.repository.pvBlockCorrections(f.key());
  f.pending = () => f.repository.pvCorrectionCandidates(f.key(), f.now);
  f.forecast = (end = target, power = 1000) => {
    for (let start = end - 4 * hour; start < end + 74 * hour; start += quarter) f.repository.saveForecast({ source: 'open-meteo', model: 'icon_d2',
      start_ms: start, end_ms: start + quarter, ghi: power / 8, dni: 0, dhi: power / 8, fetched_ms: f.now });
  };
  f.forecast();
  f.capture = (end = target, powers = [800, 2000, 820]) => {
    let result;
    for (const [index, power] of powers.entries()) {
      const time = end + (index - 1) * five;
      f.now = Math.max(f.now, time + five + 1000);
      for (const serial of serials) f.repository.saveCloudInverter({ serial, measured_ms: time, received_ms: f.now, power_w: power / 4,
        energy_today_kwh: 1, energy_total_kwh: 100 });
      result = f.learner.learn();
    }
    return result;
  };
  f.conditionRows = (end = target, { fetched = f.now, cover = 0, code = 0 } = {}) => {
    const bounds = clearSkyBounds(end), rows = [];
    for (let time = bounds.from; time <= bounds.until; time += hour) rows.push({ source: 'open-meteo', model: 'best_match', time_ms: time,
      cloud_cover: typeof cover === 'function' ? cover(time) : cover, weather_code: typeof code === 'function' ? code(time) : code, fetched_ms: fetched });
    return rows;
  };
  f.sky = (end = target, options) => {
    for (const row of f.conditionRows(end, options)) f.repository.saveWeatherCondition(weatherLocationKey(settings.location), row);
  };
  f.ready = (end = target) => { f.now = Math.max(f.now, clearSkyBounds(end).until + 1000); };
  f.finish = (end = target) => { f.now = Math.max(f.now, localDayRange(localDay(end - quarter)).end_ms); return f.learner.learn([], f.now); };
  t.after(() => f.db.close());
  return f;
}

test('bewolking wordt in hetzelfde verzoek opgehaald als echte uurpunten; null, ongeldige en ontbrekende bronwaarden worden nooit nul', () => {
  const url = forecastUrl(52, 5, 3);
  assert.match(url.searchParams.get('hourly'), /cloud_cover,weather_code/);
  assert.equal(url.searchParams.has('past_days'), false);
  assert.doesNotMatch(url.searchParams.get('minutely_15'), /cloud_cover/);
  const time = target / 1000;
  const hourly = { time: [time, time + 3600], shortwave_radiation_best_match: [100, 200],
    direct_normal_irradiance_best_match: [0, 0], diffuse_radiation_best_match: [100, 200],
    cloud_cover_best_match: [0, null], weather_code_best_match: [0, 0] };
  const result = normalizeOpenMeteo({ hourly }, target);
  assert.equal(result.rows[0].start_ms, target - hour);
  assert.equal(result.conditions[0].time_ms, target);
  assert.equal(skyCondition(result.conditions[0]), 'clear');
  assert.equal(skyCondition(result.conditions[1]), 'unknown');
  for (const covers of [undefined, [0], ['0', 0], [-1, 101]]) {
    const rows = normalizeOpenMeteo({ hourly: { ...hourly, cloud_cover_best_match: covers } }, target).conditions;
    assert.equal(rows[0].cloud_cover, null); assert.equal(skyCondition(rows[0]), 'unknown');
  }
  assert.equal(skyCondition({ cloud_cover: 0.1, weather_code: 0 }), 'cloudy');
  assert.equal(skyCondition({ cloud_cover: 0, weather_code: 1 }), 'clear');
});

test('het hele kwartier plus een uur ervoor en erna gebruikt alle beschikbare uurpunten direct, inclusief voorspellingen', (t) => {
  const f = fixture(t), bounds = clearSkyBounds(target);
  assert.equal(iso(bounds.start), '2026-10-20T06:00:00.000Z');
  assert.equal(iso(bounds.end), '2026-10-20T08:15:00.000Z');
  assert.equal(iso(bounds.until), '2026-10-20T09:00:00.000Z');
  f.sky();
  let result = checkClearSky(f.repository, f.settings.location, target, f.now);
  assert.equal(result.status, 'clear'); assert.equal(result.uses_forecast, true);
  assert.equal(Object.hasOwn(result, 'ready_at'), false);
  assert.ok(result.samples.some((row) => Date.parse(row.time) > f.now));
  f.now = bounds.end;
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now).status, 'clear');
  f.ready();
  result = checkClearSky(f.repository, f.settings.location, target, f.now);
  assert.equal(result.uses_forecast, false);
  assert.ok(result.samples.every((row) => Date.parse(row.fetched_at) < bounds.end));
  assert.equal(result.status, 'clear'); assert.equal(result.required_samples, 4); assert.equal(result.checked_samples, 4);
  assert.equal(result.max_cloud_cover_percent, 0);
});

test('de laatste Growatt-meting bewaart invoer en publiceert pas na de meetdag met opgeslagen weergegevens', (t) => {
  const f = fixture(t); f.sky();
  const fetched = f.now;
  const captured = f.capture();
  assert.equal(captured.status, 'waiting_for_day_end'); assert.equal(f.blocks().length, 0);
  assert.equal(captured.ready_at, '2026-10-20T22:00:00.000Z');
  const result = f.finish();
  assert.equal(result.status, 'updated'); assert.equal(result.factor, 0.81);
  assert.equal(result.processed_count, 1); assert.equal(f.pending().length, 0);
  const block = f.blocks()[0], sky = JSON.parse(block.sampling_json).clear_sky;
  assert.equal(block.updated_ms, f.now); assert.equal(sky.checked_at, iso(f.now));
  assert.equal(sky.uses_forecast, false); assert.ok(f.now > clearSkyBounds(target).until);
  assert.ok(sky.samples.every((row) => row.fetched_at === iso(fetched)));
  assert.equal(f.repository.countCalls('2026-10-20'), 0);
});

test('de zelfstandige dagafsluiting rekent exact vanaf Nederlandse middernacht op dagen van 23, 24 en 25 uur', (t) => {
  for (const [date, hours] of [['2026-03-29', 23], ['2026-10-25', 25], ['2026-10-28', 24]]) {
    const f = fixture(t), range = localDayRange(date), end = Date.parse(`${date}T12:15:00Z`);
    assert.equal((range.end_ms - range.start_ms) / hour, hours);
    f.now = end - 10 * minute; f.forecast(end); f.sky(end);
    const captured = f.capture(end);
    assert.equal(captured.status, 'waiting_for_day_end'); assert.equal(captured.ready_at, iso(range.end_ms));
    assert.equal(f.pending()[0].ready_ms, range.end_ms);
    f.now = range.end_ms - 1;
    assert.equal(f.learner.learn().status, 'waiting_for_day_end'); assert.equal(f.learner.tick(), null);
    assert.equal(f.blocks().length, 0);
    f.now++;
    const result = f.learner.tick();
    assert.equal(result.status, 'updated'); assert.equal(result.factor, 0.81); assert.equal(result.processed_count, 1);
    assert.equal(f.blocks()[0].updated_ms, range.end_ms); assert.equal(f.pending().length, 0);
    const saved = { ...f.blocks()[0] };
    assert.equal(f.learner.tick(), null); assert.deepEqual({ ...f.blocks()[0] }, saved);
  }
});

test('23:45–00:00 hoort bij de vorige meetdag en kan na het laatste meetpunt meteen worden afgesloten', (t) => {
  const f = fixture(t), end = localDayRange('2026-10-25').end_ms;
  f.now = end - 10 * minute; f.forecast(end); f.sky(end);
  const result = f.capture(end);
  assert.equal(result.status, 'updated'); assert.equal(result.factor, 0.81);
  assert.equal(f.blocks()[0].start_ms, end - quarter); assert.equal(f.blocks()[0].end_ms, end);
  assert.equal(localDay(f.blocks()[0].start_ms), '2026-10-25'); assert.equal(f.pending().length, 0);
});

test('de minuutcontrole sluit de dag af zonder nachtelijke Growatt- of weeropvraag en stopt vóór de database sluit', (t) => {
  const f = fixture(t); f.sky(); f.capture();
  const cutoff = localDayRange(localDay(target)).end_ms;
  f.now = cutoff - minute - 1;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const candidates = t.mock.method(f.repository, 'pvCorrectionCandidates');
  f.learner.start(); f.learner.start();
  t.after(() => f.learner.stop());
  f.now += minute; t.mock.timers.tick(minute);
  assert.equal(f.blocks().length, 0);
  f.now += minute; t.mock.timers.tick(minute);
  assert.equal(f.blocks().length, 1); assert.equal(f.blocks()[0].updated_ms, f.now);
  assert.equal(f.repository.countCalls('2026-10-20'), 0); assert.equal(f.repository.countCalls('2026-10-21'), 0);
  f.learner.stop(); f.learner.stop();
  const calls = candidates.mock.callCount();
  f.now += hour; t.mock.timers.tick(hour);
  assert.equal(candidates.mock.callCount(), calls);
});

test('herstart na een gemiste middernacht verwerkt de bewaarde invoer en negeert oude controletijden', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-day-end-'));
  const f = fixture(t, join(folder, 'data.sqlite'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  f.sky(); f.capture();
  const original = f.pending()[0].candidate_json, cutoff = localDayRange(localDay(target)).end_ms;
  f.db.prepare('UPDATE pv_correction_candidates SET ready_ms=0').run();
  assert.equal(f.learner.learn().status, 'waiting_for_day_end'); assert.equal(f.blocks().length, 0);
  f.db.prepare('UPDATE pv_correction_candidates SET ready_ms=?').run(cutoff + 7 * 86400000);
  f.now = cutoff + 9 * hour; f.restart();
  assert.equal(f.pending()[0].candidate_json, original);
  f.learner.start(); f.learner.stop();
  assert.equal(f.blocks().length, 1); assert.equal(f.blocks()[0].factor, 0.81);
  assert.equal(f.blocks()[0].updated_ms, f.now); assert.equal(f.pending().length, 0);
});

test('de bewolkingsgrens wordt bij de dagafsluiting op de laatst opgeslagen uurpunten getoetst', (t) => {
  const f = fixture(t); f.sky(); f.capture();
  f.now += hour; f.sky(target, { cover: 1 });
  assert.equal(f.finish().status, 'clouds_present'); assert.equal(f.blocks().length, 0);
  f.now++; f.sky();
  assert.equal(f.learner.tick().status, 'updated'); assert.equal(f.blocks()[0].factor, 0.81);
});

test('een geblokkeerd vorig etmaal blijft zichtbaar naast wachtende kwartieren van de lopende dag', (t) => {
  const f = fixture(t); f.sky(target, { cover: 1 }); f.capture();
  assert.equal(f.finish().status, 'clouds_present');
  const next = target + 86400000;
  f.now = next - 10 * minute; f.forecast(next); f.sky(next);
  assert.equal(f.capture(next).status, 'clouds_present'); assert.equal(f.pending().length, 2);
  f.settings.pv.automatic_correction.max_cloud_cover_percent = 1;
  assert.equal(f.learner.tick().processed_count, 1);
  assert.equal(f.blocks().length, 1); assert.equal(f.blocks()[0].end_ms, target);
  assert.equal(f.pending().length, 1); assert.equal(f.pending()[0].end_ms, next);
});

test('een echt meer-modelantwoord bewaart dezelfde ICON-D2-bewolking voor de berekening na de meetdag', async (t) => {
  const f = fixture(t); assert.equal(f.capture().status, 'waiting_for_day_end');
  const bounds = clearSkyBounds(target), times = f.conditionRows().map((row) => row.time_ms / 1000);
  const quarters = [];
  for (let time = bounds.from; time <= bounds.until; time += quarter) quarters.push(time / 1000);
  const json = { hourly: { time: times, shortwave_radiation_best_match: times.map(() => 125), direct_normal_irradiance_best_match: times.map(() => 0), diffuse_radiation_best_match: times.map(() => 125),
    cloud_cover_best_match: times.map(() => 100), weather_code_best_match: times.map(() => 3),
    cloud_cover_icon_d2: times.map(() => 0), weather_code_icon_d2: times.map(() => 0) },
    minutely_15: { time: quarters, shortwave_radiation_icon_d2: quarters.map(() => 125), direct_normal_irradiance_icon_d2: quarters.map(() => 0), diffuse_radiation_icon_d2: quarters.map(() => 125) } };
  let processed;
  const weather = createWeatherScheduler({ ...f, panelErrors: [], clock: () => f.now,
    source: async () => normalizeOpenMeteo(json, f.now), onForecast: () => { processed = f.learner.learn(); } });
  assert.equal((await weather.tick()).reason, 'ok');
  assert.equal(processed.status, 'waiting_for_day_end'); assert.equal(f.blocks().length, 0);
  processed = f.finish();
  assert.equal(processed.status, 'updated'); assert.equal(processed.factor, 0.81);
  assert.equal(f.pending().length, 0); assert.equal(f.blocks().length, 1);
  const stored = f.repository.weatherConditions(weatherLocationKey(f.settings.location), bounds.from, bounds.until);
  assert.equal(stored.length, 4);
  assert.ok(stored.every((row) => row.model === 'icon_d2' && row.cloud_cover === 0 && row.weather_code === 0));
  assert.ok(processed.clear_sky.samples.every((row) => row.cloud_cover_percent === 0));
  assert.equal(f.repository.countCalls('2026-10-20'), 1);
});

test('iedere uurwaarde boven de grens blokkeert het hele venster; ontbrekende uurpunten worden niet geïnterpoleerd', (t) => {
  const f = fixture(t);
  const times = f.conditionRows().map((row) => row.time_ms);
  for (const time of times) {
    f.now++;
    for (const row of f.conditionRows()) f.repository.saveWeatherCondition(weatherLocationKey(f.settings.location), {
      ...row, ...(row.time_ms === time ? { cloud_cover: 0.01 } : {}) });
    assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now).status, 'clouds_present');
  }
  f.now++; f.sky();
  f.db.prepare('DELETE FROM weather_conditions WHERE time_ms=?').run(times[1]);
  const result = checkClearSky(f.repository, f.settings.location, target, f.now);
  assert.equal(result.status, 'clear_sky_data_missing'); assert.deepEqual(result.missing_times, [iso(times[1])]);
  f.now++; f.sky(target, { code: null });
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now).status, 'clear_sky_data_missing');
});

test('latere onbekende bewolkingsdata vervangen oude heldere waarden; een andere locatie of toekomstige ontvangst geeft geen goedkeuring', (t) => {
  const f = fixture(t); f.sky();
  const first = f.conditionRows()[0];
  f.repository.saveWeatherCondition(weatherLocationKey(f.settings.location), { ...first, cloud_cover: null, fetched_ms: ++f.now });
  f.repository.saveWeatherCondition(weatherLocationKey(f.settings.location), first);
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now).status, 'clear_sky_data_missing');
  f.now++; f.sky(target, { fetched: f.now + 1 });
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now).status, 'waiting_for_clear_sky_data');
  assert.equal(checkClearSky(f.repository, { latitude: 53, longitude: 5 }, target, f.now).status, 'clear_sky_data_missing');
});

test('de procentgrens geldt inclusief de grenswaarde voor ieder uurpunt; weercode 3 is geen extra blokkade', (t) => {
  const f = fixture(t);
  f.sky(target, { cover: 20, code: 3 });
  const allowed = checkClearSky(f.repository, f.settings.location, target, f.now, 20);
  assert.equal(allowed.status, 'clear');
  assert.equal(allowed.max_allowed_cloud_cover_percent, 20);
  assert.equal(allowed.max_cloud_cover_percent, 20);
  assert.ok(allowed.samples.every((row) => row.weather_code === 3));
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now).status, 'clouds_present');
  for (const time of f.conditionRows().map((row) => row.time_ms)) {
    f.now++;
    f.sky(target, { cover: (at) => at === time ? 20.01 : 0, code: 3 });
    assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now, 20).status, 'clouds_present');
  }
  f.now++; f.sky(target, { cover: 0.5, code: 1 });
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now, 0.5).status, 'clear');
});

test('100 procent staat volledig bewolkte uurpunten toe, maar ontbrekende of ongeldige gegevens blijven blokkeren', (t) => {
  const f = fixture(t); f.sky(target, { cover: 100, code: 3 });
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now, 100).status, 'clear');
  f.now++; f.sky(target, { cover: null, code: 3 });
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now, 100).status, 'clear_sky_data_missing');
  f.now++; f.sky(target, { cover: 100, code: null });
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now, 100).status, 'clear_sky_data_missing');
  f.now++; f.sky(target, { cover: 100, code: 3, fetched: f.now + 1 });
  assert.equal(checkClearSky(f.repository, f.settings.location, target, f.now, 100).status, 'waiting_for_clear_sky_data');
});

test('de productiedienst berekent bij een grens van 100 procent ook met weercode 3 een echte kwartiercorrectie', (t) => {
  const f = fixture(t);
  f.settings.pv.automatic_correction.max_cloud_cover_percent = 100;
  f.sky(target, { cover: 100, code: 3 });
  assert.equal(f.capture().status, 'waiting_for_day_end');
  const learned = f.finish();
  assert.equal(learned.status, 'updated'); assert.equal(learned.factor, 0.81);
  assert.equal(learned.clear_sky.max_allowed_cloud_cover_percent, 100);
  assert.equal(learned.clear_sky.max_cloud_cover_percent, 100);
  assert.ok(learned.clear_sky.samples.every((row) => row.weather_code === 3));
  assert.equal(f.blocks().length, 1);
});

test('de interne weerpagina en openbare correctieonderbouwing tonen de ingestelde grens zonder het weericoon aan te passen', async (t) => {
  const f = fixture(t);
  f.settings.pv.automatic_correction.max_cloud_cover_percent = 40;
  f.sky(target, { cover: 40, code: 3 });
  assert.equal(f.capture().status, 'waiting_for_day_end');
  assert.equal(f.finish().status, 'updated');
  f.sky(target + 86400000, { cover: 40, code: 3 });
  t.mock.method(Date, 'now', () => f.now);
  const weather = { status: () => ({ source: 'open-meteo', location_configured: true, poll_minutes: 120, used_requests: 0,
    sunrise: iso(localDayRange(localDay(f.now)).start_ms + 6 * hour), sunset: iso(localDayRange(localDay(f.now)).start_ms + 18 * hour) }) };
  const server = startHttpServer({ ...f, panelErrors: [], weather, homewizard: { status: () => ({}) } });
  await once(server, 'listening'); t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    assert.equal(response.status, 200); return response.json();
  };
  const overview = await get('/intern/api/v1/weather');
  assert.equal(overview.conditions.max_allowed_cloud_cover_percent, 40);
  assert.ok(overview.conditions.rows.length > 0);
  assert.ok(overview.conditions.rows.every((row) => row.correction_condition === 'clear' && row.condition === 'partly_cloudy' && row.weather_code === 3));
  const snapshot = await get('/api/v1/dashboard');
  const correction = snapshot.forecasts.days[0].automatic_correction;
  assert.equal(correction.latest.sampling.clear_sky.max_allowed_cloud_cover_percent, 40);
  assert.equal(correction.last_attempt.clear_sky.max_allowed_cloud_cover_percent, 40);
  assert.ok(snapshot.forecasts.days[0].conditions.rows.every((row) => row.condition === 'partly_cloudy'));
  const display = {};
  renderPvCorrection(display, correction);
  assert.match(display.title, /Bewolking binnen 40%/);
  const page = await (await fetch(`http://127.0.0.1:${server.address().port}/intern/weather`)).text();
  assert.match(page, /Binnen correctiegrens/);
  assert.match(page, /id="correction-cloud-limit"/);
});

test('een ruimere grens hervat een wachtende correctie na herstart op de oorspronkelijke basis; aanscherpen wist eerdere factoren niet', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-cloud-limit-'));
  const f = fixture(t, join(folder, 'data.sqlite'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  f.capture(); f.sky(target, { cover: 40, code: 3 });
  f.capture(target + quarter);
  assert.equal(f.finish().status, 'clouds_present');
  const modelKey = f.key();
  assert.equal(f.pending().length, 2);
  f.settings.pv.automatic_correction.max_cloud_cover_percent = 40;
  f.now++; f.restart();
  const learned = f.learner.learn();
  assert.equal(learned.status, 'updated'); assert.equal(learned.factor, 0.81);
  assert.equal(learned.clear_sky.max_allowed_cloud_cover_percent, 40);
  assert.equal(f.key(), modelKey); assert.equal(f.pending().length, 0);
  const approved = { ...f.blocks()[0] };
  assert.equal(JSON.parse(approved.sampling_json).clear_sky.max_allowed_cloud_cover_percent, 40);
  f.settings.pv.automatic_correction.max_cloud_cover_percent = 10;
  f.now = target + 86400000 - 10 * minute; f.forecast(target + 86400000);
  f.sky(target + 86400000, { cover: 40, code: 3 });
  assert.equal(f.capture(target + 86400000).status, 'waiting_for_day_end');
  assert.equal(f.finish(target + 86400000).status, 'clouds_present');
  assert.equal(f.blocks().length, 2);
  assert.deepEqual({ ...f.blocks()[0] }, approved);
  const display = {};
  renderPvCorrection(display, createPvForecastModel(f.repository, f.settings, f.panels, f.now).status());
  assert.match(display.textContent, /bewolking boven 10%/);
  assert.match(display.title, /Bewolking binnen 40%/);
  assert.match(display.title, /Maximaal 10% bewolking/);
});

test('de productiedienst bewaart eerst het meetdrietal en berekent de factor pas na goedkeuring op de oorspronkelijke basis', (t) => {
  const f = fixture(t);
  assert.equal(f.capture().status, 'waiting_for_day_end');
  assert.equal(f.blocks().length, 0); assert.equal(f.pending().length, 1);
  const pending = JSON.parse(f.pending()[0].candidate_json);
  assert.equal(pending.predicted_w, 1000); assert.equal(pending.measured_w, 810);
  assert.equal(Object.hasOwn(pending, 'factor'), false);
  const signature = f.pending()[0].signature;
  f.learner.learn(); assert.equal(f.pending().length, 1); assert.equal(f.pending()[0].signature, signature);
  f.now += 21 * minute; // Een later weerbericht mag de opgeslagen oorspronkelijke basis niet verwisselen.
  assert.ok(f.now < clearSkyBounds(target).until);
  f.forecast(target, 2000); // Het later ophalen van weerdata mag de opgeslagen basis niet verwisselen.
  f.sky();
  assert.equal(f.learner.learn().status, 'waiting_for_day_end');
  const result = f.finish();
  assert.equal(result.status, 'updated'); assert.equal(result.factor, 0.81); assert.equal(result.processed_count, 1);
  assert.equal(f.pending().length, 0);
  const block = f.blocks()[0], sampling = JSON.parse(block.sampling_json);
  assert.equal(block.predicted_w, 1000); assert.equal(block.measured_w, 810);
  assert.equal(sampling.used_samples, 2); assert.deepEqual(sampling.ignored_times, [iso(target)]);
  assert.equal(sampling.clear_sky.status, 'clear'); assert.equal(sampling.clear_sky.samples.length, 4);
  assert.equal(sampling.clear_sky.uses_forecast, false);
  const stored = f.repository.pv(target - quarter, target);
  assert.ok(stored.every((row) => row.correction_factor === 0.81));
  assert.equal(stored.reduce((sum, row) => sum + row.power_w, 0), 810);
  const before = { ...block }; f.learner.learn();
  assert.deepEqual({ ...f.blocks()[0] }, before);
});

test('bewolking boven de grens voorkomt ook na de meetdag een nieuwe factor; geldige weerdata hervatten daarna', (t) => {
  const f = fixture(t); f.capture(); f.sky(target, { cover: 1 });
  const result = f.finish();
  assert.equal(result.status, 'clouds_present'); assert.equal(f.blocks().length, 0); assert.equal(f.pending().length, 1);
  const display = {};
  renderPvCorrection(display, createPvForecastModel(f.repository, f.settings, f.panels, f.now).status());
  assert.match(display.textContent, /bewolking boven 0%/); assert.match(display.title, /Hoogste bewolking: 1%/);
  f.now++; f.sky();
  assert.equal(f.learner.learn().status, 'updated'); assert.equal(f.blocks()[0].factor, 0.81);
});

test('een gewone weeropvraag verwerkt alle gereedstaande kwartieren na de transactie, zonder extra weerverzoeken', async (t) => {
  const f = fixture(t); f.capture(target, [800, 820, 840]); f.capture(target + quarter, [900, 920, 940]);
  assert.equal(f.pending().length, 2); assert.ok(f.now < clearSkyBounds(target + quarter).until);
  f.now = localDayRange(localDay(target)).end_ms;
  let requests = 0, processed;
  const weather = createWeatherScheduler({ ...f, panelErrors: [], clock: () => f.now,
    source: async () => {
      requests++;
      return { sun: [], conditions: f.conditionRows(target + quarter), rows: f.repository.forecast(target - quarter, target + 2 * quarter) };
    }, onForecast: () => { processed = f.learner.learn(); } });
  assert.equal((await weather.tick()).reason, 'ok');
  assert.equal(requests, 1); assert.equal(f.repository.countCalls('2026-10-21'), 1);
  assert.equal(processed.processed_count, 2); assert.equal(f.pending().length, 0);
  assert.deepEqual(f.blocks().map((row) => row.factor), [0.82, 0.92]);
  assert.ok(f.blocks().every((row) => JSON.parse(row.sampling_json).clear_sky.status === 'clear'));
});

test('kandidaten en bewolking overleven herstart en logs wissen; v6-migratie bewaart de oorspronkelijke metingen', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-clear-sky-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const f = fixture(t, join(folder, 'data.sqlite')); f.capture();
  const measurements = f.repository.cloudInverterHistory(0, Infinity).length;
  f.repository.clearGrowattDiagnostics(); f.repository.clearWeatherDiagnostics(); f.restart();
  assert.equal(f.pending().length, 1); assert.equal(f.repository.cloudInverterHistory(0, Infinity).length, measurements);
  f.db.prepare('UPDATE pv_correction_candidates SET ready_ms=?').run(clearSkyBounds(target).until);
  f.sky(); f.restart();
  assert.equal(f.learner.learn().status, 'waiting_for_day_end');
  f.now = localDayRange(localDay(target)).end_ms;
  assert.equal(f.learner.learn().status, 'updated'); assert.equal(f.blocks().length, 1);
  const block = { ...f.blocks()[0] };
  f.db.exec('DROP TABLE weather_conditions; DROP TABLE pv_correction_candidates; PRAGMA user_version=6');
  f.restart();
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual({ ...f.blocks()[0] }, block);
  assert.equal(f.repository.cloudInverterHistory(0, Infinity).length, measurements);
  assert.equal(f.pending().length, 0);
});

test('uitschakelen of een ander paneelmodel publiceert geen wachtend blok en verlopen kandidaten worden opgeruimd', (t) => {
  const f = fixture(t); f.capture(); f.sky();
  f.settings.pv = { ...f.settings.pv, automatic_correction: { enabled: false } };
  assert.equal(f.learner.learn().status, 'disabled'); assert.equal(f.blocks().length, 0); assert.equal(f.pending().length, 1);
  f.settings.pv.automatic_correction.enabled = true;
  const panels = { ...f.panels, groups: f.panels.groups.map((group) => ({ ...group, wp_per_panel: 401 })) };
  createPvCorrectionLearner({ ...f, panels, panelErrors: [], clock: () => f.now }).learn();
  assert.equal(f.blocks().length, 0); assert.equal(f.pending().length, 1);
  f.now = target + 49 * hour;
  f.learner.learn(); assert.equal(f.pending().length, 0); assert.equal(f.blocks().length, 0);
});

test('een mislukte cacheverversing houdt het kandidaatblok vast en publiceert geen halve correctie', (t) => {
  const f = fixture(t); f.capture(); f.sky();
  f.now = localDayRange(localDay(target)).end_ms;
  const repository = { ...f.repository, savePv() { throw new Error('Testfout cacheverversing'); } };
  const learner = createPvCorrectionLearner({ ...f, repository, panelErrors: [], clock: () => f.now });
  assert.equal(learner.learn().status, 'error'); assert.equal(f.blocks().length, 0); assert.equal(f.pending().length, 1);
  assert.equal(f.learner.learn().status, 'updated'); assert.equal(f.pending().length, 0);
});

test('bewolkingscontrole gebruikt echte UTC-uren bij middernacht en beide wintertijduren', (t) => {
  const f = fixture(t);
  for (const end of [Date.parse('2026-10-19T22:00:00Z'), Date.parse('2026-10-25T00:15:00Z'), Date.parse('2026-10-25T01:15:00Z')]) {
    f.now = end + five;
    f.sky(end);
    const result = checkClearSky(f.repository, f.settings.location, end, f.now);
    assert.equal(result.status, 'clear');
    assert.equal(Date.parse(result.window_end) - Date.parse(result.window_start), 2 * hour + quarter);
    const points = result.samples.map((row) => Date.parse(row.time));
    assert.ok(points.slice(1).every((time, index) => time - points[index] === hour));
  }
});

test('de interne weerpagina toont bewolking en de openbare correctiestatus geeft alleen de toegestane wachtinformatie', async (t) => {
  const f = fixture(t); f.capture(); f.sky();
  t.mock.method(Date, 'now', () => f.now);
  const weather = { status: () => ({ source: 'open-meteo', location_configured: true, poll_minutes: 120, used_requests: 0,
    sunrise: iso(localDayRange(localDay(f.now)).start_ms + 6 * hour), sunset: iso(localDayRange(localDay(f.now)).start_ms + 18 * hour) }) };
  const server = startHttpServer({ ...f, panelErrors: [], weather, homewizard: { status: () => ({}) } });
  await once(server, 'listening'); t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    assert.equal(response.status, 200); return response.json();
  };
  const overview = await get('/intern/api/v1/weather');
  assert.equal(overview.conditions.time_basis, 'instant'); assert.equal(overview.conditions.resolution_minutes, 60);
  assert.ok(overview.conditions.rows.some((row) => row.condition === 'clear' && row.cloud_cover_percent === 0 && row.weather_code === 0));
  const page = await (await fetch(`http://127.0.0.1:${server.address().port}/intern/weather`)).text();
  assert.match(page, /Bewolking vandaag/); assert.match(page, /weather-conditions/);
  const snapshot = await get('/api/v1/dashboard');
  const status = snapshot.forecasts.days[0].automatic_correction;
  assert.equal(status.last_attempt.status, 'waiting_for_day_end');
  assert.equal(status.last_attempt.ready_at, '2026-10-20T22:00:00.000Z');
  assert.equal(Object.hasOwn(status.last_attempt, 'clear_sky'), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /INV000000|location_key|candidate_json|latitude|signature/);
  const display = {}; renderPvCorrection(display, status);
  assert.match(display.textContent, /wachten tot de meetdag voorbij is/); assert.match(display.title, /21-10-2026.*00:00/);
  assert.equal(f.finish().status, 'updated');
  const approvedSnapshot = await get('/api/v1/dashboard');
  const approved = approvedSnapshot.forecasts.days[0].automatic_correction;
  for (const [index, day] of approvedSnapshot.forecasts.days.entries()) {
    const slot = day.slots.find((row) => Date.parse(row.end) === target + (index + 1) * 86400000);
    assert.equal(slot.correction_computed_at, iso(f.now));
    assert.notEqual(slot.correction_computed_at, slot.correction_reference_end);
  }
  assert.equal(approved.latest.sampling.clear_sky.status, 'clear');
  assert.equal(approved.latest.sampling.clear_sky.uses_forecast, false);
  renderPvCorrection(display, approved);
  assert.match(display.title, /Bewolking binnen 0%: 08:00–10:15/);
  assert.doesNotMatch(display.title, /bewolkingsverwachting.*direct gebruikt/);
  f.now = target + 86400000 - 10 * minute; f.forecast(target + 86400000);
  f.capture(target + 86400000);
  const waiting = (await get('/api/v1/dashboard')).forecasts.days[0].automatic_correction;
  renderPvCorrection(display, waiting);
  assert.match(display.textContent, /Correctie -19%.*wachten tot de meetdag voorbij is/);
  assert.equal((await get('/intern/api/v1/database/rows?table=pv_correction_candidates')).total_rows, 1);
});
