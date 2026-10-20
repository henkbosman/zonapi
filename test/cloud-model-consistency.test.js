import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenMeteo } from '../src/weather/open-meteo-client.js';
import { skyCondition } from '../src/weather/clear-sky.js';

/** Bouwt een echt meer-modelantwoord met afwijkende bewolking en beperkte kwartierdekking; input: UTC-begin; output: Open-Meteo-JSON met beide modellen. */
function response(start) {
  const times = [start, start + 3600000, start + 7200000, start + 2 * 86400000].map((ms) => ms / 1000);
  const minutely = Array.from({ length: 9 }, (_, index) => start / 1000 + index * 900);
  return { hourly: { time: times, shortwave_radiation_best_match: [100, 110, 120, 130], direct_normal_irradiance_best_match: [0, 0, 0, 0], diffuse_radiation_best_match: [100, 110, 120, 130],
    cloud_cover_best_match: [100, 100, 100, 100], weather_code_best_match: [3, 3, 3, 3],
    cloud_cover_icon_d2: [0, 0, 0, 0], weather_code_icon_d2: [0, 0, 0, 0] },
    minutely_15: { time: minutely, shortwave_radiation_icon_d2: minutely.map(() => 125), direct_normal_irradiance_icon_d2: minutely.map(() => 0), diffuse_radiation_icon_d2: minutely.map(() => 125) } };
}

test('bewolking volgt het kwartierinstralingsmodel en valt buiten zijn dekking terug op Best Match, ook rond wintertijd', () => {
  for (const start of [Date.parse('2026-10-20T08:00:00Z'), Date.parse('2026-10-25T00:00:00Z')]) {
    const json = response(start), result = normalizeOpenMeteo(json, start);
    assert.deepEqual(result.conditions.map((row) => row.model), ['icon_d2', 'icon_d2', 'icon_d2', 'best_match']);
    assert.deepEqual(result.conditions.map((row) => row.cloud_cover), [0, 0, 0, 100]);
    assert.deepEqual(result.conditions.map((row) => row.weather_code), [0, 0, 0, 3]);
    assert.deepEqual(result.conditions.map((row) => row.time_ms), json.hourly.time.map((time) => time * 1000));
    assert.equal(result.rows.find((row) => row.model === 'icon_d2').start_ms, start - 900000);
  }
});

test('onvolledige modelparen worden nooit samengevoegd tot een kunstmatig heldere hemel', () => {
  const start = Date.parse('2026-10-20T08:00:00Z'), json = response(start);
  json.hourly.cloud_cover_best_match = [100, 50, null, 100];
  json.hourly.weather_code_best_match = [3, 2, 0, 3];
  json.hourly.cloud_cover_icon_d2 = [0, null, 0, 0];
  json.hourly.weather_code_icon_d2 = [null, 0, null, 0];
  const result = normalizeOpenMeteo(json, start);
  assert.deepEqual(result.conditions.map((row) => [row.model, row.cloud_cover, row.weather_code]), [
    ['best_match', 100, 3], ['best_match', 50, 2], ['icon_d2', 0, null], ['best_match', 100, 3]
  ]);
  assert.equal(skyCondition(result.conditions[2]), 'unknown');
});

test('uurmodus en oude antwoorden blijven werken; velden uit gemengde antwoordvormen vullen elkaar niet aan', () => {
  const start = Date.parse('2026-10-20T08:00:00Z'), json = response(start);
  assert.ok(normalizeOpenMeteo(json, start, 60).conditions.every((row) => row.model === 'best_match' && row.cloud_cover === 100));
  delete json.hourly.weather_code_best_match;
  json.hourly.weather_code = [0, 0, 0, 0];
  assert.ok(normalizeOpenMeteo(json, start, 60).conditions.every((row) => row.weather_code === null));
  delete json.hourly.cloud_cover_best_match;
  json.hourly.cloud_cover = [0, 0, 0, 0];
  assert.ok(normalizeOpenMeteo(json, start, 60).conditions.every((row) => row.cloud_cover === 0 && row.weather_code === 0));
});
