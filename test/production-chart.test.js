import test from 'node:test';
import assert from 'node:assert/strict';
import { productionSeries } from '../src/api/production-series.js';
import { drawProductionChart } from '../public/dashboard-production-chart.js';
import { forecastLinePoints, lineValueAt, blockCorrectionAt, blockCorrectionComputedAt, quarterWeatherPoints } from '../public/production-chart-series.js';
import { skyAppearance } from '../src/weather/sky-appearance.js';

test('weericonen volgen het echte bewolkingspercentage en behandelen onbekende percentages niet als nul', () => {
  assert.equal(skyAppearance(0), 'clear');
  for (const cover of [0.01, 1, 20, 50, 79.999]) assert.equal(skyAppearance(cover), 'partly_cloudy');
  for (const cover of [80, 95, 100]) assert.equal(skyAppearance(cover), 'cloudy');
  for (const cover of [null, undefined, '0', NaN, Infinity, -1, 101]) assert.equal(skyAppearance(cover), 'unknown');
});

test('kwartiericonen gebruiken de dichtstbijzijnde uurbron zonder ontbrekende uren of herhaalde wintertijduren te vermengen', () => {
  const start = Date.parse('2026-10-25T00:00:00Z'), hour = 3600000;
  const conditions = { rows: [
    { time: new Date(start).toISOString(), condition: 'clear', cloud_cover_percent: 0, weather_code: 0 },
    { time: new Date(start + 2 * hour).toISOString(), condition: 'cloudy', cloud_cover_percent: 100, weather_code: 3 }
  ] };
  const points = quarterWeatherPoints(conditions, start, start + 2 * hour);
  assert.equal(points.length, 8);
  assert.deepEqual(points.map((point) => point.condition), ['clear', 'clear', 'unknown', 'unknown', 'unknown', 'unknown', 'cloudy', 'cloudy']);
  assert.ok(points.every((point) => point.ms % 900000 === 0));
  assert.ok(points.every((point) => Math.abs(point.sourceMs - (point.ms - 450000)) <= hour / 2));
  assert.deepEqual(points.map((point) => point.sourceMs), [0, 0, 1, 1, 1, 1, 2, 2].map((offset) => start + offset * hour));
});

test('alle drie daggrafieken tonen een leesbaar icoon per klokkwartier boven de lijnen, met brontijd en weer in de cursor', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: (tag) => element(tag) };
  try {
    for (const width of [280, 780, 1180]) for (const dayIndex of [0, 1, 2]) {
      const start = Date.parse('2026-10-20T06:00:00Z') + dayIndex * 86400000, end = start + 12 * 3600000;
      const rows = Array.from({ length: 13 }, (_, index) => ({ time: new Date(start + index * 3600000).toISOString(),
        condition: ['clear', 'partly_cloudy', 'cloudy', 'unknown'][index % 4], cloud_cover_percent: index % 4 === 3 ? null : index % 4 * 50,
        weather_model: 'icon_d2', fetched_at: '2026-10-20T04:00:00Z', weather_code: 45, stale: index % 4 === 2 }));
      const slots = Array.from({ length: 48 }, (_, index) => ({ start: new Date(start + index * 900000).toISOString(),
        end: new Date(start + (index + 1) * 900000).toISOString(), power_w: 800, base_power_w: 1000, automatic_correction_factor: 0.8,
        correction_computed_at: '2026-10-19T09:00:00Z' }));
      const container = element('div'); container.clientWidth = width;
      drawProductionChart(container, { sunrise: new Date(start).toISOString(), sunset: new Date(end).toISOString(), now: new Date(start + 6 * 3600000).toISOString(), points: [] }, slots,
        { forecastOnly: dayIndex > 0, baseloadW: 400, conditions: { rows } });
      const svg = container.children[0], strip = svg.children.find((child) => 'data-weather-icons' in child.attributes);
      const icons = strip.children.filter((child) => 'data-weather-time' in child.attributes);
      assert.equal(icons.length, 48); assert.equal(Number(svg.attributes.height), 400);
      assert.ok(Number(svg.attributes.width) >= Math.max(width, 934));
      assert.deepEqual(new Set(icons.map((icon) => icon.attributes['data-weather-condition'])), new Set(['clear', 'partly_cloudy', 'cloudy', 'unknown']));
      const positions = icons.map((icon) => Number(icon.attributes.transform.match(/translate\(([^,]+)/)[1]));
      assert.ok(positions.slice(1).every((x, index) => x - positions[index] >= 17.99));
      const dots = svg.children.filter((child) => child.attributes['data-series'] === 'forecast');
      for (const [index, icon] of icons.entries()) {
        assert.equal(icon.attributes['data-weather-time'], dots[index].attributes['data-time']);
        assert.ok(Math.abs(positions[index] + 8 - Number(dots[index].attributes.cx)) < 0.000001);
        assert.match(icon.children[0].textContent, /Uurverwachting:/);
        assert.match(icon.children[0].textContent, /Model: ICON-D2.*Opgehaald:.*Weercode: 45/);
        if (icon.attributes['data-weather-condition'] === 'cloudy') assert.match(icon.children[0].textContent, /Verouderde weerdata/);
        assert.equal(icon.attributes['aria-label'], icon.children[0].textContent);
      }
      assert.ok(Number(strip.children[0].attributes.y) + Number(strip.children[0].attributes.height) < 64);
      const target = svg.children.find((child) => child.attributes.role === 'slider');
      target.listeners.keydown({ key: 'End', preventDefault() {} });
      assert.match(target.attributes['aria-valuetext'], /Weer: Helder/);
      assert.match(target.attributes['aria-valuetext'], /Correctie berekend: 19-10-2026, 11:00/);
      const cursor = svg.children.find((child) => 'data-chart-cursor' in child.attributes);
      const box = cursor.children.find((child) => 'data-chart-values' in child.attributes).children[0];
      assert.ok(Number(box.attributes.x) >= (container.scrollLeft || 0));
      assert.ok(Number(box.attributes.x) + Number(box.attributes.width) <= (container.scrollLeft || 0) + width);
    }
  } finally { globalThis.document = before; }
});

/** Maakt een kleine SVG/DOM-testnode; input: tagnaam; output: node met kinderen en attributen. */
function element(tagName) {
  return {
    tagName, attributes: {}, children: [], textContent: '', listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    getBoundingClientRect() { return { left: 100, width: 390 }; }
  };
}

test('de daggrafiek tekent geen individuele omvormers of onvolledige totalen', () => {
  const noon = Date.parse('2026-10-14T10:00:00Z');
  const sunrise = '2026-10-14T05:00:00Z';
  const sunset = '2026-10-14T16:00:00Z';
  const rows = [
    { serial: 'A', measured_ms: noon, power_w: 100 },
    { serial: 'B', measured_ms: noon, power_w: 200 },
    { serial: 'C', measured_ms: noon, power_w: 300 },
    { serial: 'A', measured_ms: noon + 13 * 60000, power_w: 110 }
  ];
  const points = productionSeries(rows, noon + 15 * 60000, sunrise, sunset, 4, 12);
  assert.deepEqual(points, []);
});

test('ongelijke cloudmeettijden vormen één totaal per ronde zonder tussenstanden of dubbeltelling', () => {
  const start = Date.parse('2026-10-14T10:00:00Z');
  const serials = ['A', 'B', 'C', 'D'];
  const rows = [0, 1].flatMap((round) => serials.map((serial, index) => ({ serial,
    measured_ms: start + round * 300000 + index * 5000, power_w: (index + 1) * 100 + round * 10, source: 'cloud' })));
  rows.push({ serial: 'onbekend', measured_ms: start, power_w: 9000 });
  rows.push({ ...rows[0] });
  rows.push({ serial: 'A', measured_ms: start + 3600000, power_w: 8000 });
  const points = productionSeries(rows.reverse(), start + 600000, '2026-10-14T06:00:00Z', '2026-10-14T18:00:00Z', 4, 12, serials, 300);
  assert.deepEqual(points.map((point) => [point.time, point.power_w, point.active_inverters, point.source]), [
    ['2026-10-14T10:00:15.000Z', 1000, 4, 'cloud'], ['2026-10-14T10:05:15.000Z', 1040, 4, 'cloud']
  ]);
});

test('oude omvormerwaarden worden niet in een later totaal opgenomen', () => {
  const start = Date.parse('2026-10-14T10:00:00Z');
  const rows = ['A', 'B', 'C', 'D'].map((serial) => ({ serial, measured_ms: start, power_w: 100 }));
  rows.push({ serial: 'A', measured_ms: start + 13 * 60000, power_w: 200 });
  const points = productionSeries(rows, start + 14 * 60000, null, null, 4, 12);
  assert.deepEqual(points.map((point) => point.power_w), [400]);
});

test('daggrafiek bewaart de hele voorspelling, verbindt uurpunten schuin en toont tijd en beide vermogens bij de cursor', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: (tag) => element(tag) };
  try {
    const container = element('div');
    const day = {
      sunrise: '2026-10-14T06:00:00Z', sunset: '2026-10-14T18:00:00Z', now: '2026-10-14T12:00:00Z', fresh_minutes: 12,
      points: [
        { time: '2026-10-14T11:30:00Z', power_w: 200, active_inverters: 4, expected_inverters: 4 },
        { time: '2026-10-14T11:40:00Z', power_w: 100, active_inverters: 1, expected_inverters: 4 },
        { time: '2026-10-14T12:00:00Z', power_w: 600, active_inverters: 4, expected_inverters: 4 }
      ]
    };
    const forecast = [0, 0, 200, 350, 500, 600, 500, 700, 800, 900, 1500, 700, 100, 0].map((power_w, index) => ({
      start: new Date(Date.parse('2026-10-14T05:00:00Z') + index * 3600000).toISOString(),
      end: new Date(Date.parse('2026-10-14T06:00:00Z') + index * 3600000).toISOString(), power_w
    }));
    drawProductionChart(container, day, forecast);
    const svg = container.children[0];
    assert.equal(svg.tagName, 'svg');
    assert.equal(svg.children.filter((child) => child.tagName === 'path').length, 2);
    const circles = svg.children.filter((child) => child.tagName === 'circle');
    assert.equal(circles.filter((child) => child.attributes.fill === '#137771').length, 2);
    const measuredPath = svg.children.find((child) => child.tagName === 'path' && child.attributes.stroke === '#137771').attributes.d;
    assert.equal((measuredPath.match(/M/g) ?? []).length, 1);
    assert.equal((measuredPath.match(/L/g) ?? []).length, 1);
    const forecastXs = circles.filter((child) => child.attributes.fill === '#e6a321').map((child) => Number(child.attributes.cx));
    assert.equal(Math.min(...forecastXs), 52);
    assert.equal(Math.max(...forecastXs), 762);
    assert.equal(new Set(forecastXs).size, forecastXs.length);
    const path = svg.children.find((child) => child.tagName === 'path' && child.attributes.stroke === '#e6a321').attributes.d;
    const coordinates = [...path.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
    assert.ok(coordinates.every((point, index) => !index || point.x > coordinates[index - 1].x));
    assert.ok(coordinates.some((point, index) => index && point.y !== coordinates[index - 1].y));
    const marker = svg.children.find((child) => child.tagName === 'line' && child.attributes['stroke-dasharray'] === '5 4');
    assert.equal(Number(marker.attributes.x1), 407);
    assert.ok(svg.children.some((child) => child.tagName === 'text' && child.textContent === 'Nu'));
    const target = svg.children.find((child) => child.attributes.role === 'slider');
    const cursor = svg.children.find((child) => 'data-chart-cursor' in child.attributes);
    target.listeners.pointermove({ clientX: 100 + 407 / 2 });
    assert.equal(cursor.attributes.visibility, 'visible');
    assert.equal(Number(cursor.children[0].attributes.x1), 407);
    assert.equal(cursor.children[2].textContent, '14:00:00');
    const values = cursor.children.find((child) => 'data-chart-values' in child.attributes);
    assert.deepEqual(values.children.filter((child) => child.tagName === 'text').map((child) => child.textContent), ['Gemeten: 600 W', 'Voorspelling: 500 W']);
    const middleX = 52 + 710 * 5.75 / 12;
    target.listeners.pointermove({ clientX: 100 + middleX / 2 });
    assert.equal(cursor.children[2].textContent, '13:45:00');
    assert.equal(values.children.filter((child) => child.tagName === 'text')[0].textContent, 'Gemeten: 400 W');
    const futureX = 52 + 710 * 10 / 12;
    target.listeners.pointermove({ clientX: 100 + futureX / 2 });
    assert.equal(cursor.children[2].textContent, '18:00:00');
    assert.deepEqual(values.children.filter((child) => child.tagName === 'text').map((child) => child.textContent), ['Gemeten: —', 'Voorspelling: 1.500 W']);
    const valueBox = values.children[0].attributes;
    assert.ok(Number(valueBox.x) >= 52 && Number(valueBox.x) + Number(valueBox.width) <= 762);
    target.listeners.pointerleave();
    assert.equal(cursor.attributes.visibility, 'hidden');
    target.listeners.keydown({ key: 'End', preventDefault() {} });
    assert.equal(cursor.children[2].textContent, '20:00:00');
    assert.equal(Number(cursor.children[0].attributes.x1), 762);
  } finally { globalThis.document = before; }
});

test('tijdcursor gebruikt dezelfde lineaire waarden als de grafiek en vult geen gaten in metingen op', () => {
  const start = Date.parse('2026-10-14T10:00:00Z');
  const slots = [250, 450].map((power_w, index) => ({ start: new Date(start + index * 3600000).toISOString(), end: new Date(start + (index + 1) * 3600000).toISOString(), power_w }));
  const points = forecastLinePoints(slots, start, start + 2 * 3600000);
  assert.deepEqual(points.map((point) => point.value), [250, 250, 450]);
  assert.equal(lineValueAt(points, start + 3600000, 75 * 60000), 250);
  assert.equal(lineValueAt(points, start + 90 * 60000, 75 * 60000), 350);
  const measured = [{ ms: start, value: 200 }, { ms: start + 10 * 60000, value: 400 }, { ms: start + 40 * 60000, value: 600 }];
  assert.equal(lineValueAt(measured, start + 5 * 60000, 12 * 60000), 300);
  assert.equal(lineValueAt(measured, start + 20 * 60000, 12 * 60000), null);
  assert.equal(lineValueAt(measured, start - 1, 12 * 60000), null);
  assert.equal(lineValueAt(measured, start + 41 * 60000, 12 * 60000), null);
  const incomplete = forecastLinePoints([slots[0], { start: new Date(start + 3 * 3600000).toISOString(), end: new Date(start + 4 * 3600000).toISOString(), power_w: 900 }], start, start + 4 * 3600000);
  assert.equal(lineValueAt(incomplete, start + 2 * 3600000, 75 * 60000), null);
});

test('de dagvoorspelling blijft zowel voor zonsopkomst als na zonsondergang volledig zichtbaar', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: (tag) => element(tag) };
  try {
    for (const hour of ['04', '22']) {
      const container = element('div');
      const slots = [];
      for (let at = Date.parse('2026-10-14T05:00:00Z'); at < Date.parse('2026-10-14T18:00:00Z'); at += 3600000) slots.push({ start: new Date(at).toISOString(), end: new Date(at + 3600000).toISOString(), power_w: 500 });
      drawProductionChart(container, { sunrise: '2026-10-14T06:03:00Z', sunset: '2026-10-14T16:47:00Z', now: `2026-10-14T${hour}:00:00Z`, points: [] }, slots);
      const svg = container.children[0];
      const native = svg.children.filter((child) => child.tagName === 'circle');
      assert.ok(native.every((point) => Date.parse(point.attributes['data-time']) % 3600000 === 0));
      assert.ok(native.every((point) => Number(point.attributes.cx) > 52 && Number(point.attributes.cx) < 762));
      const path = svg.children.find((child) => child.tagName === 'path').attributes.d;
      assert.match(path, /^M52\.0,/);
      assert.match(path, /L762\.0,/);
    }
  } finally { globalThis.document = before; }
});

test('lege daggrafiek behoudt de zonuren, ook voor zonsopkomst en na zonsondergang', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: (tag) => element(tag) };
  try {
    for (const hour of ['04', '22']) {
      const container = element('div');
      drawProductionChart(container, { sunrise: '2026-10-14T06:03:00Z', sunset: '2026-10-14T16:47:00Z', now: `2026-10-14T${hour}:00:00Z`, points: [] }, []);
      const svg = container.children[0];
      assert.equal(svg.tagName, 'svg');
      const texts = svg.children.filter((child) => child.tagName === 'text').map((child) => child.textContent);
      assert.ok(texts.includes('08:03'));
      assert.ok(texts.includes('18:47'));
      assert.ok(texts.includes('Geen meetpunten'));
      assert.ok(!texts.includes('Nu'));
    }
  } finally { globalThis.document = before; }
});

test('lichte basisvoorspelling bepaalt mede de schaal en correctiepercentages blijven zichtbaar bij punten en cursor', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: (tag) => element(tag) };
  try {
    const container = element('div'), start = Date.parse('2026-10-14T10:00:00Z');
    const slots = [0.5, 1, 1.5].map((factor, index) => ({ start: new Date(start + index * 900000).toISOString(),
      end: new Date(start + (index + 1) * 900000).toISOString(), power_w: Math.min(1500, 2000 * factor), base_power_w: 2000,
      automatic_correction_factor: factor }));
    drawProductionChart(container, { sunrise: new Date(start).toISOString(), sunset: new Date(start + 2700000).toISOString(), now: new Date(start).toISOString(), points: [] }, slots, { forecastOnly: true, baseloadW: 400 });
    const svg = container.children[0], paths = svg.children.filter((child) => child.tagName === 'path');
    assert.equal(paths[0].attributes.stroke, '#efd7a2'); assert.equal(paths[0].attributes['stroke-width'], '2');
    assert.equal(paths[1].attributes.stroke, '#e6a321'); assert.match(paths[0].attributes.d, /,24\.0/);
    const dots = svg.children.filter((child) => child.attributes['data-series'] === 'forecast');
    assert.match(dots[0].children[0].textContent, /Correctie -50%/);
    assert.match(dots[2].children[0].textContent, /Correctie \+50%/);
    const target = svg.children.find((child) => child.attributes.role === 'slider');
    target.listeners.focus(); target.listeners.keydown({ key: 'End', preventDefault() {} });
    assert.match(target.attributes['aria-valuetext'], /Zonder correctie: 2.000 W/);
    assert.match(target.attributes['aria-valuetext'], /Correctie: \+50%/);
    target.listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
    assert.match(target.attributes['aria-valuetext'], /Correctie: 0%/);
    target.listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
    assert.match(target.attributes['aria-valuetext'], /Correctie: -50%/);
    const baseDots = svg.children.filter((child) => child.attributes['data-series'] === 'base_forecast');
    assert.equal(baseDots.length, 3); assert.match(baseDots[0].children[0].textContent, /Zonder correctie/);
  } finally { globalThis.document = before; }
});

test('datum en tijd van de berekende kwartiercorrectie blijven zichtbaar in popup en punttooltip op alle dagen en schermbreedtes', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: (tag) => element(tag) };
  try {
    for (const width of [280, 780]) for (const day of [0, 1, 2]) {
      const start = Date.parse('2026-10-20T10:00:00Z') + day * 86400000;
      const dates = ['2026-10-19T09:00:00Z', '2026-10-20T08:30:00Z', null];
      const slots = [0.8, 1, 1].map((factor, index) => ({ start: new Date(start + index * 900000).toISOString(),
        end: new Date(start + (index + 1) * 900000).toISOString(), power_w: 1000 * factor, base_power_w: 1000,
        automatic_correction_factor: factor, correction_computed_at: dates[index] }));
      const container = element('div'); container.clientWidth = width;
      drawProductionChart(container, { sunrise: new Date(start).toISOString(), sunset: new Date(start + 2700000).toISOString(),
        now: new Date(start).toISOString(), points: [] }, slots, { forecastOnly: day > 0, baseloadW: 400 });
      const svg = container.children[0], target = svg.children.find((child) => child.attributes.role === 'slider');
      const dots = svg.children.filter((child) => child.attributes['data-series'] === 'forecast');
      assert.match(dots[0].children[0].textContent, /Correctie berekend: 19-10-2026, 11:00/);
      assert.match(dots[1].children[0].textContent, /Correctie 0%.*Correctie berekend: 20-10-2026, 10:30/);
      assert.doesNotMatch(dots[2].children[0].textContent, /Correctie berekend/);
      target.listeners.focus(); target.listeners.keydown({ key: 'End', preventDefault() {} });
      assert.match(target.attributes['aria-valuetext'], /Correctie berekend: —/);
      target.listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
      assert.match(target.attributes['aria-valuetext'], /Correctie berekend: 20-10-2026, 10:30/);
      target.listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
      assert.match(target.attributes['aria-valuetext'], /Correctie berekend: 19-10-2026, 11:00/);
      assert.equal(blockCorrectionComputedAt(slots, start + 900000), Date.parse(dates[0]));
      assert.equal(blockCorrectionComputedAt(slots, start + 900001), Date.parse(dates[1]));
      const cursor = svg.children.find((child) => 'data-chart-cursor' in child.attributes);
      const values = cursor.children.find((child) => 'data-chart-values' in child.attributes), box = values.children[0];
      const dateLabel = values.children.find((child) => child.textContent === 'Correctie berekend:');
      const dateValue = values.children.find((child) => child.textContent === '19-10-2026, 11:00');
      assert.ok(Number(dateValue.attributes.y) > Number(dateLabel.attributes.y));
      assert.ok(Number(box.attributes.x) >= 52 && Number(box.attributes.x) + Number(box.attributes.width) <= width - 18);
      assert.ok(values.children.filter((child) => child.tagName === 'text').every((child) => Number(child.attributes.y) < Number(box.attributes.y) + Number(box.attributes.height)));
      assert.ok(svg.children.filter((child) => child.attributes['data-series'] === 'base_forecast').every((child) => !child.children[0].textContent.includes('Correctie berekend')));
    }
  } finally { globalThis.document = before; }
});

test('mouseover leest uitsluitend de correctie van het eigen blok en mengt geen percentages van buurblokken', () => {
  const start = Date.parse('2026-10-18T12:00:00Z');
  const slots = [0.5, 1, 1.2].map((factor, index) => ({ start: new Date(start + index * 900000).toISOString(),
    end: new Date(start + (index + 1) * 900000).toISOString(), power_w: 1000 * factor, automatic_correction_factor: factor }));
  assert.equal(blockCorrectionAt(slots, start + 900000), -50);
  assert.equal(blockCorrectionAt(slots, start + 900001), 0);
  assert.equal(blockCorrectionAt(slots, start + 1200000), 0);
  assert.equal(blockCorrectionAt(slots, start + 1800000), 0);
  assert.ok(Math.abs(blockCorrectionAt(slots, start + 1800001) - 20) < 0.000001);
  assert.equal(blockCorrectionAt(slots, start - 1), null);
  assert.equal(blockCorrectionAt(slots, start + 2700001), null);
});
