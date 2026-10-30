import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { createWeatherScheduler } from '../src/weather/scheduler.js';
import { createPvCorrectionLearner } from '../src/pv/correction-learner.js';
import { createPvForecastModel } from '../src/pv/forecast-model.js';
import { correctionModelKey } from '../src/pv/correction-key.js';
import { learnPvCorrection } from '../src/pv/learn-correction.js';
import { weatherLocationKey } from '../src/weather/clear-sky.js';

const minute = 60000, quarter = 900000, day = 86400000;
const end = Date.parse('2026-10-29T10:45:00Z'); // 11:30–11:45 Nederlandse wintertijd.
const iso = (ms) => new Date(ms).toISOString();

/** Maakt twee paneelgroepen en echte opslag met een bestuurbare weerbron; input: testcontext; output: klok, voorspelling, leerfunctie en originele groepsbasis. */
function fixture(t) {
  const { settings } = loadConfiguration();
  settings.location = { latitude: 52, longitude: 5 };
  settings.growatt = { ...settings.growatt, expected_inverters: 1, production_source: 'cloud' };
  settings.weather.poll_minutes = 15;
  const panels = { expected_panel_count: 10, inverters: [{ id: 'inv', serial: 'TEST123456', ac_limit_w: 10000 }], groups: [
    { id: 'roof-a', inverter_id: 'inv', count: 6, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 },
    { id: 'roof-b', inverter_id: 'inv', count: 4, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 1 }
  ] };
  const db = openDatabase(':memory:'), repository = createRepository(db);
  const f = { settings, panels, db, repository, now: end - 30 * minute, ghi: 500 };
  f.key = correctionModelKey(settings, panels);
  f.row = (at = end) => ({ source: 'open-meteo', model: 'best_match', start_ms: at - quarter, end_ms: at,
    ghi: f.ghi, dni: 0, dhi: f.ghi, fetched_ms: f.now });
  f.weather = createWeatherScheduler({ settings, panels, panelErrors: [], repository, clock: () => f.now,
    source: async () => ({ rows: [0, 1, 2].map((offset) => f.row(end + offset * day)), sun: [] }) });
  f.learner = createPvCorrectionLearner({ settings, panels, panelErrors: [], repository, clock: () => f.now });
  f.value = (at = end) => createPvForecastModel(repository, settings, panels, f.now).estimate(repository.forecast(at - 1, at)[0]);
  f.trio = () => {
    for (const offset of [-5, 0, 5]) repository.saveCloudInverter({ serial: 'TEST123456', measured_ms: end + offset * minute,
      received_ms: f.now, power_w: 1402.7, energy_today_kwh: 1, energy_total_kwh: 100 });
  };
  f.finish = () => {
    repository.saveWeatherCondition(weatherLocationKey(settings.location), { source: 'open-meteo', model: 'best_match',
      time_ms: end - quarter, cloud_cover: 0, weather_code: 0, fetched_ms: f.now });
    f.now = Date.parse('2026-10-29T23:00:00Z');
    return f.learner.learn([], f.now);
  };
  t.after(() => db.close());
  return f;
}

test('een latere weerupdate wijzigt de leerbasis niet als de grafiek de oorspronkelijke voorspelling bewaart', async (t) => {
  const f = fixture(t);
  assert.equal((await f.weather.tick()).reason, 'ok');
  assert.equal(f.value().base_power_w, 2000);
  f.now = end + 10 * minute; f.ghi = 325;
  assert.equal((await f.weather.refresh()).reason, 'ok');
  assert.equal(f.repository.forecast(end - 1, end)[0].ghi, 325);
  assert.equal(f.value().base_power_w, 2000);
  assert.equal(f.repository.pv(end - quarter, end).reduce((sum, row) => sum + row.base_power_w, 0), 2000);
  f.trio();
  assert.equal(f.learner.learn().status, 'waiting_for_day_end');
  const candidate = JSON.parse(f.repository.pvCorrectionCandidates(f.key, f.now)[0].candidate_json);
  assert.equal(candidate.predicted_w, 2000);
  assert.equal(candidate.measured_w, 1402.7);
  assert.equal(candidate.end_ms, end);
  const basis = JSON.parse(candidate.sampling_json).forecast;
  assert.deepEqual(basis.groups.map((group) => [group.group_id, group.power_w, group.gti_w_m2]), [
    ['roof-a', 1200, 500], ['roof-b', 800, 500]
  ]);
  const learned = f.finish();
  assert.equal(learned.status, 'updated'); assert.equal(learned.factor, 0.70135);
  assert.equal(learned.block_end, iso(end));
  assert.equal(f.value().base_power_w, 2000); assert.equal(f.value().power_w, 1402.7);
  const tomorrow = f.value(end + day);
  assert.equal(tomorrow.correction_factor, 0.70135); assert.equal(tomorrow.correction_reference_end, iso(end));
  assert.equal(tomorrow.base_power_w, 1300);
});

test('een overgenomen automatische factor wordt niet in de nieuwe leerbasis gestapeld en oude correcties blijven intact', async (t) => {
  const f = fixture(t), previousEnd = end - day;
  f.repository.savePvBlockCorrection({ model_key: f.key, start_ms: previousEnd - quarter, end_ms: previousEnd, factor: 0.5,
    predicted_w: 2000, measured_w: 1000, measured_ms: previousEnd + 5 * minute, updated_ms: previousEnd + 10 * minute,
    signature: 'previous-day-factor', sampling_json: '{}' });
  const previous = { ...f.repository.pvBlockCorrection(f.key, previousEnd) };
  assert.equal((await f.weather.tick()).reason, 'ok');
  f.now = end + 10 * minute; f.ghi = 325;
  assert.equal((await f.weather.refresh()).reason, 'ok');
  assert.equal(f.value().base_power_w, 2000); assert.equal(f.value().power_w, 1000);
  assert.equal(f.value().correction_source, 'same_clock_quarter');
  f.trio(); assert.equal(f.learner.learn().status, 'waiting_for_day_end');
  const candidate = JSON.parse(f.repository.pvCorrectionCandidates(f.key, f.now)[0].candidate_json);
  assert.equal(candidate.predicted_w, 2000);
  assert.deepEqual(JSON.parse(candidate.sampling_json).forecast.groups.map((group) => group.power_w), [1200, 800]);
  assert.equal(f.finish().factor, 0.70135);
  assert.equal(f.repository.pvBlockCorrections(f.key).length, 2);
  assert.deepEqual({ ...f.repository.pvBlockCorrection(f.key, previousEnd) }, previous);
});

test('zonder volledige passende modelcache valt de leerbasis volledig terug op de actuele ongecorrigeerde bron', (t) => {
  for (const scenario of ['missing', 'other_model', 'incomplete']) {
    const f = fixture(t);
    f.now = end + 10 * minute; f.ghi = 325;
    const row = f.row(); f.repository.saveForecast(row);
    if (scenario !== 'missing') for (const [index, group] of f.panels.groups.entries()) {
      if (scenario === 'incomplete' && index === 1) continue;
      f.repository.savePv({ ...row, group_id: group.id, gti_w_m2: 500, power_w: index ? 800 : 1200,
        base_power_w: index ? 800 : 1200, correction_factor: 1, computed_ms: f.now,
        model_key: scenario === 'other_model' ? 'different-model' : f.key });
    }
    const learned = learnPvCorrection(f.repository, f.settings, f.panels, [], [{ serial: 'TEST123456', source: 'cloud',
      power_w: 1402.7, measured_ms: end + 5 * minute, received_ms: f.now }], f.now, { target_ms: end, defer: false });
    assert.equal(learned.status, 'updated'); assert.equal(learned.factor, 1.079, scenario);
    const block = f.repository.pvBlockCorrection(f.key, end);
    assert.equal(block.predicted_w, 1300, scenario);
    assert.deepEqual(JSON.parse(block.sampling_json).forecast.groups.map((group) => group.power_w), [780, 520], scenario);
  }
});
