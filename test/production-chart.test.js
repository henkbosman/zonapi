import test from 'node:test';
import assert from 'node:assert/strict';
import { productionSeries } from '../src/api/production-series.js';
import { drawProductionChart } from '../public/dashboard-production-chart.js';
import { forecastLinePoints, lineValueAt } from '../public/production-chart-series.js';

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
    assert.equal(cursor.children[2].textContent, '14:00');
    const values = cursor.children.find((child) => 'data-chart-values' in child.attributes);
    assert.deepEqual(values.children.filter((child) => child.tagName === 'text').map((child) => child.textContent), ['Gemeten: 600 W', 'Voorspelling: 600 W']);
    const middleX = 52 + 710 * 5.75 / 12;
    target.listeners.pointermove({ clientX: 100 + middleX / 2 });
    assert.equal(cursor.children[2].textContent, '13:45');
    assert.equal(values.children.filter((child) => child.tagName === 'text')[0].textContent, 'Gemeten: 400 W');
    const futureX = 52 + 710 * 10 / 12;
    target.listeners.pointermove({ clientX: 100 + futureX / 2 });
    assert.equal(cursor.children[2].textContent, '18:00');
    assert.deepEqual(values.children.filter((child) => child.tagName === 'text').map((child) => child.textContent), ['Gemeten: —', 'Voorspelling: 1.100 W']);
    const valueBox = values.children[0].attributes;
    assert.ok(Number(valueBox.x) >= 52 && Number(valueBox.x) + Number(valueBox.width) <= 762);
    target.listeners.pointerleave();
    assert.equal(cursor.attributes.visibility, 'hidden');
    target.listeners.keydown({ key: 'End', preventDefault() {} });
    assert.equal(cursor.children[2].textContent, '20:00');
    assert.equal(Number(cursor.children[0].attributes.x1), 762);
  } finally { globalThis.document = before; }
});

test('tijdcursor gebruikt dezelfde lineaire waarden als de grafiek en vult geen gaten in metingen op', () => {
  const start = Date.parse('2026-10-14T10:00:00Z');
  const slots = [250, 450].map((power_w, index) => ({ start: new Date(start + index * 3600000).toISOString(), end: new Date(start + (index + 1) * 3600000).toISOString(), power_w }));
  const points = forecastLinePoints(slots, start, start + 2 * 3600000);
  assert.deepEqual(points.map((point) => point.value), [250, 250, 450, 450]);
  assert.equal(lineValueAt(points, start + 3600000, 75 * 60000), 350);
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
      const xs = container.children[0].children.filter((child) => child.tagName === 'circle').map((child) => Number(child.attributes.cx));
      assert.equal(Math.min(...xs), 52);
      assert.equal(Math.max(...xs), 762);
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
