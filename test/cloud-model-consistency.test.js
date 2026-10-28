import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenMeteo } from '../src/weather/open-meteo-client.js';
import { skyCondition } from '../src/weather/clear-sky.js';

/** Bouwt een oud meer-modelantwoord met afwijkende bewolking en Best Match-kwartierdekking; input: UTC-begin; output: Open-Meteo-JSON met beide modellen. */
function response(start) {
  const times = [start, start + 3600000, start + 7200000, start + 2 * 86400000].map((ms) => ms / 1000);
  const minutely = Array.from({ length: 9 }, (_, index) => start / 1000 + index * 900);
  return { hourly: { time: times, shortwave_radiation_best_match: [100, 110, 120, 130], direct_normal_irradiance_best_match: [0, 0, 0, 0], diffuse_radiation_best_match: [100, 110, 120, 130],
    cloud_cover_best_match: [100, 100, 100, 100], weather_code_best_match: [3, 3, 3, 3],
    cloud_cover_icon_d2: [0, 0, 0, 0], weather_code_icon_d2: [0, 0, 0, 0] },
    minutely_15: { time: minutely, shortwave_radiation_best_match: minutely.map(() => 125), direct_normal_irradiance_best_match: minutely.map(() => 0), diffuse_radiation_best_match: minutely.map(() => 125),
      shortwave_radiation_icon_d2: minutely.map(() => 999), direct_normal_irradiance_icon_d2: minutely.map(() => 0), diffuse_radiation_icon_d2: minutely.map(() => 999) } };
}

test('bewolking en alle instraling gebruiken uitsluitend Best Match, ook bij afwijkende ICON-velden en wintertijd', () => {
  for (const start of [Date.parse('2026-10-20T08:00:00Z'), Date.parse('2026-10-25T00:00:00Z')]) {
    const json = response(start), result = normalizeOpenMeteo(json, start);
    assert.deepEqual(result.conditions.map((row) => row.model), ['best_match', 'best_match', 'best_match', 'best_match']);
    assert.deepEqual(result.conditions.map((row) => row.cloud_cover), [100, 100, 100, 100]);
    assert.deepEqual(result.conditions.map((row) => row.weather_code), [3, 3, 3, 3]);
    assert.deepEqual(result.conditions.map((row) => row.time_ms), json.hourly.time.map((time) => time * 1000));
    assert.equal(result.rows.find((row) => row.end_ms - row.start_ms === 900000).start_ms, start - 900000);
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
    ['best_match', 100, 3], ['best_match', 50, 2], ['best_match', null, 0], ['best_match', 100, 3]
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

test('een enkel Best Match-model zonder veldsuffix bewaart de oorspronkelijke uur- en kwartiertijden aan beide kanten van middernacht', () => {
  const now = Date.parse('2026-10-27T23:05:00Z'), start = Math.floor(now / 3600000) * 3600000;
  const times = Array.from({ length: 5 }, (_, index) => (start + (index - 3) * 3600000) / 1000);
  const quarters = Array.from({ length: 17 }, (_, index) => (start + (index - 12) * 900000) / 1000);
  const series = (time) => ({ time, shortwave_radiation: time.map(() => 200), direct_normal_irradiance: time.map(() => 100), diffuse_radiation: time.map(() => 50) });
  const json = { hourly: { ...series(times), cloud_cover: [10, 20, 30, 40, 50], weather_code: [0, 1, 2, 3, 3] }, minutely_15: series(quarters) };
  const result = normalizeOpenMeteo(json, now);
  assert.ok(result.rows.every((row) => row.model === 'best_match' && row.fetched_ms === now));
  assert.deepEqual(result.conditions.map((row) => row.time_ms), times.map((time) => time * 1000));
  assert.deepEqual(result.conditions.map((row) => row.cloud_cover), [10, 20, 30, 40, 50]);
  assert.equal(result.rows.filter((row) => row.end_ms - row.start_ms === 900000).length, 17);
  assert.equal(Math.min(...result.conditions.map((row) => row.time_ms)), start - 3 * 3600000);
  assert.ok(result.conditions.some((row) => row.time_ms < start));
  assert.ok(normalizeOpenMeteo(json, now, 60).rows.every((row) => row.end_ms - row.start_ms === 3600000));
});

test('ontbrekende Best Match-instraling wordt niet met ICON-D2 of velden uit een andere antwoordvorm aangevuld', () => {
  const start = Date.parse('2026-10-28T09:00:00Z'), json = response(start);
  delete json.minutely_15.diffuse_radiation_best_match;
  json.minutely_15.diffuse_radiation = json.minutely_15.time.map(() => 0);
  assert.throws(() => normalizeOpenMeteo(json, start), /Onvolledige Open-Meteo-kwartierreeks/);
  delete json.minutely_15.shortwave_radiation_best_match;
  delete json.minutely_15.direct_normal_irradiance_best_match;
  delete json.minutely_15.diffuse_radiation;
  const result = normalizeOpenMeteo(json, start);
  assert.ok(result.rows.every((row) => row.model === 'best_match' && row.end_ms - row.start_ms === 3600000));
  assert.equal(result.rows.length, 4);
});
