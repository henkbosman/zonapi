import test from 'node:test';
import assert from 'node:assert/strict';
import { productionSeries } from '../src/api/production-series.js';
import { drawProductionChart } from '../public/dashboard-production-chart.js';

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

test('dezelfde dag toont één tot vier omvormers zonder oude waarden bij te tellen', () => {
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
  assert.deepEqual(points.map((point) => [point.power_w, point.active_inverters]), [[600, 3], [110, 1]]);
});

test('grafiek toont gemeten punt, daggrenzen, nu-lijn en hoogstens drie uur voorspelling', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: (tag) => element(tag) };
  try {
    const container = element('div');
    const day = {
      sunrise: '2026-10-14T06:00:00Z', sunset: '2026-10-14T18:00:00Z', now: '2026-10-14T12:00:00Z', fresh_minutes: 12,
      points: [{ time: '2026-10-14T11:59:00Z', power_w: 600, active_inverters: 3, expected_inverters: 4 }]
    };
    const forecast = [
      { start: '2026-10-14T12:00:00Z', end: '2026-10-14T13:00:00Z', power_w: 700 },
      { start: '2026-10-14T13:00:00Z', end: '2026-10-14T14:00:00Z', power_w: 800 },
      { start: '2026-10-14T14:00:00Z', end: '2026-10-14T15:00:00Z', power_w: 900 },
      { start: '2026-10-14T15:00:00Z', end: '2026-10-14T16:00:00Z', power_w: 1500 }
    ];
    drawProductionChart(container, day, forecast);
    const svg = container.children[0];
    assert.equal(svg.tagName, 'svg');
    assert.equal(svg.children.filter((child) => child.tagName === 'path').length, 2);
    const circles = svg.children.filter((child) => child.tagName === 'circle');
    assert.equal(circles.filter((child) => child.attributes.fill === '#137771').length, 1);
    assert.equal(Math.max(...circles.filter((child) => child.attributes.fill === '#e6a321').map((child) => Number(child.attributes.cx))), 584.5);
    const marker = svg.children.find((child) => child.tagName === 'line' && child.attributes['stroke-dasharray'] === '5 4');
    assert.equal(Number(marker.attributes.x1), 407);
    assert.ok(svg.children.some((child) => child.tagName === 'text' && child.textContent === 'Nu'));
    const target = svg.children.find((child) => child.attributes.role === 'slider');
    const cursor = svg.children.find((child) => 'data-chart-cursor' in child.attributes);
    target.listeners.pointermove({ clientX: 100 + 407 / 2 });
    assert.equal(cursor.attributes.visibility, 'visible');
    assert.equal(Number(cursor.children[0].attributes.x1), 407);
    assert.equal(cursor.children[2].textContent, '14:00');
    target.listeners.pointerleave();
    assert.equal(cursor.attributes.visibility, 'hidden');
    target.listeners.keydown({ key: 'End', preventDefault() {} });
    assert.equal(cursor.children[2].textContent, '20:00');
    assert.equal(Number(cursor.children[0].attributes.x1), 762);
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
