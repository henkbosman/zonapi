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
  t.after(() => f.db.close());
  return f;
}

test('bewolking wordt in hetzelfde verzoek opgehaald als echte uurpunten; null, ongeldige en ontbrekende bronwaarden worden nooit nul', () => {
  const url = forecastUrl(52, 5, 3);
  assert.match(url.searchParams.get('hourly'), /cloud_cover,weather_code/);
  assert.equal(url.searchParams.get('past_days'), '2');
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
  assert.equal(skyCondition({ cloud_cover: 0, weather_code: 1 }), 'cloudy');
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

test('de laatste Growatt-meting publiceert direct met eerder opgehaalde heldere verwachtingen, zonder nieuwe weeropvraag', (t) => {
  const f = fixture(t); f.sky();
  const fetched = f.now;
  const result = f.capture();
  assert.equal(result.status, 'updated'); assert.equal(result.factor, 0.81);
  assert.equal(result.processed_count, 1); assert.equal(f.pending().length, 0);
  const block = f.blocks()[0], sky = JSON.parse(block.sampling_json).clear_sky;
  assert.equal(block.updated_ms, f.now); assert.equal(sky.checked_at, iso(f.now));
  assert.equal(sky.uses_forecast, true); assert.ok(f.now < clearSkyBounds(target).until);
  assert.ok(sky.samples.every((row) => row.fetched_at === iso(fetched)));
  assert.equal(f.repository.countCalls('2026-10-20'), 0);
});

test('een echt meer-modelantwoord gebruikt dezelfde heldere ICON-D2-data voor de opgeslagen bewolking en de directe correctie', async (t) => {
  const f = fixture(t); assert.equal(f.capture().status, 'clear_sky_data_missing');
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
  assert.equal(processed.status, 'updated'); assert.equal(processed.factor, 0.81);
  assert.equal(f.pending().length, 0); assert.equal(f.blocks().length, 1);
  const stored = f.repository.weatherConditions(weatherLocationKey(f.settings.location), bounds.from, bounds.until);
  assert.equal(stored.length, 4);
  assert.ok(stored.every((row) => row.model === 'icon_d2' && row.cloud_cover === 0 && row.weather_code === 0));
  assert.ok(processed.clear_sky.samples.every((row) => row.cloud_cover_percent === 0));
  assert.equal(f.repository.countCalls('2026-10-20'), 1);
});

test('iedere bewolkte uurwaarde of niet-heldere weercode blokkeert het hele venster; ontbrekende uurpunten worden niet geïnterpoleerd', (t) => {
  const f = fixture(t);
  const times = f.conditionRows().map((row) => row.time_ms);
  for (const time of times) for (const field of ['cloud_cover', 'weather_code']) {
    f.now++;
    for (const row of f.conditionRows()) f.repository.saveWeatherCondition(weatherLocationKey(f.settings.location), {
      ...row, ...(row.time_ms === time ? { [field]: field === 'cloud_cover' ? 0.01 : 1 } : {}) });
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

test('de productiedienst bewaart eerst het meetdrietal en berekent de factor pas na goedkeuring op de oorspronkelijke basis', (t) => {
  const f = fixture(t);
  assert.equal(f.capture().status, 'clear_sky_data_missing');
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
  const result = f.learner.learn();
  assert.equal(result.status, 'updated'); assert.equal(result.factor, 0.81); assert.equal(result.processed_count, 1);
  assert.equal(f.pending().length, 0);
  const block = f.blocks()[0], sampling = JSON.parse(block.sampling_json);
  assert.equal(block.predicted_w, 1000); assert.equal(block.measured_w, 810);
  assert.equal(sampling.used_samples, 2); assert.deepEqual(sampling.ignored_times, [iso(target)]);
  assert.equal(sampling.clear_sky.status, 'clear'); assert.equal(sampling.clear_sky.samples.length, 4);
  assert.equal(sampling.clear_sky.uses_forecast, true);
  const stored = f.repository.pv(target - quarter, target);
  assert.ok(stored.every((row) => row.correction_factor === 0.81));
  assert.equal(stored.reduce((sum, row) => sum + row.power_w, 0), 810);
  const before = { ...block }; f.learner.learn();
  assert.deepEqual({ ...f.blocks()[0] }, before);
});

test('voorspelde bewolking voorkomt een nieuwe factor; een heldere weerupdate hervat direct zonder tijdvenster', (t) => {
  const f = fixture(t); f.capture(); f.sky(target, { cover: 1 });
  const result = f.learner.learn();
  assert.equal(result.status, 'clouds_present'); assert.equal(f.blocks().length, 0); assert.equal(f.pending().length, 1);
  const display = {};
  renderPvCorrection(display, createPvForecastModel(f.repository, f.settings, f.panels, f.now).status());
  assert.match(display.textContent, /niet volledig onbewolkt/); assert.match(display.title, /Hoogste bewolking: 1%/);
  f.now++; f.sky();
  assert.equal(f.learner.learn().status, 'updated'); assert.equal(f.blocks()[0].factor, 0.81);
});

test('een gewone weeropvraag verwerkt alle gereedstaande kwartieren na de transactie, zonder extra weerverzoeken', async (t) => {
  const f = fixture(t); f.capture(target, [800, 820, 840]); f.capture(target + quarter, [900, 920, 940]);
  assert.equal(f.pending().length, 2); assert.ok(f.now < clearSkyBounds(target + quarter).until);
  let requests = 0, processed;
  const weather = createWeatherScheduler({ ...f, panelErrors: [], clock: () => f.now,
    source: async () => {
      requests++;
      return { sun: [], conditions: f.conditionRows(target + quarter), rows: f.repository.forecast(target - quarter, target + 2 * quarter) };
    }, onForecast: () => { processed = f.learner.learn(); } });
  assert.equal((await weather.tick()).reason, 'ok');
  assert.equal(requests, 1); assert.equal(f.repository.countCalls('2026-10-20'), 1);
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
  assert.ok(f.now < f.pending()[0].ready_ms, 'Een bewaard wachttijdstip uit de vorige versie mag niet blokkeren');
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
  const weather = { status: () => ({ source: 'open-meteo', location_configured: true, max_requests: 12, used_requests: 0,
    sunrise: iso(target - 2 * hour), sunset: iso(target + 10 * hour) }) };
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
  assert.equal(status.last_attempt.status, 'clear_sky_data_missing');
  assert.equal(status.last_attempt.clear_sky.uses_forecast, true);
  assert.equal(Object.hasOwn(status.last_attempt.clear_sky, 'ready_at'), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /INV000000|location_key|candidate_json|latitude|signature/);
  const display = {}; renderPvCorrection(display, status);
  assert.match(display.textContent, /bewolkingsgegevens ontbreken/); assert.match(display.title, /08:00 tot 10:15/);
  assert.equal(f.learner.learn().status, 'updated');
  const approvedSnapshot = await get('/api/v1/dashboard');
  const approved = approvedSnapshot.forecasts.days[0].automatic_correction;
  for (const [index, day] of approvedSnapshot.forecasts.days.entries()) {
    const slot = day.slots.find((row) => Date.parse(row.end) === target + index * 86400000);
    assert.equal(slot.correction_computed_at, iso(f.now));
    assert.notEqual(slot.correction_computed_at, slot.correction_reference_end);
  }
  assert.equal(approved.latest.sampling.clear_sky.status, 'clear');
  assert.equal(approved.latest.sampling.clear_sky.uses_forecast, true);
  renderPvCorrection(display, approved);
  assert.match(display.title, /Volgens weer-API onbewolkt: 08:00–10:15/);
  assert.match(display.title, /bewolkingsverwachting.*direct gebruikt/);
  f.capture(target + 2 * hour);
  const waiting = (await get('/api/v1/dashboard')).forecasts.days[0].automatic_correction;
  renderPvCorrection(display, waiting);
  assert.match(display.textContent, /Correctie -19%.*bewolkingsgegevens ontbreken/);
  assert.equal((await get('/intern/api/v1/database/rows?table=pv_correction_candidates')).total_rows, 1);
});
