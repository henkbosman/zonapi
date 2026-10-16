import test from 'node:test';
import assert from 'node:assert/strict';
import { setupProductionDayCharts } from '../public/dashboard-production-days.js';

/** Maakt een DOM-node met een meetbare grafiekbreedte; input: tagnaam en optionele breedte; output: node voor tekenen, cursor en resize-events. */
function element(tagName, width = 0) {
  return { tagName, clientWidth: width, attributes: {}, children: [], listeners: {}, textContent: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    getBoundingClientRect() { return { left: 0, width: Number(this.attributes.width ?? this.clientWidth) }; } };
}

test('drie ruime daggrafieken behouden hun eigen zonuren, cursorwaarden en hoogte bij verschillende schermbreedtes', () => {
  const previousDocument = globalThis.document, previousObserver = globalThis.ResizeObserver;
  const ids = ['pv-chart', 'pv-chart-tomorrow', 'pv-chart-after-tomorrow'];
  const nodes = new Map(ids.map((id, index) => [id, element('div', [1100, 720, 320][index])]));
  for (let index = 0; index < 3; index++) nodes.set(`pv-date-${index}`, element('span'));
  for (let index = 1; index < 3; index++) nodes.set(`forecast-note-${index}`, element('div'));
  let resized;
  const observed = [];
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: (tag) => element(tag), getElementById: (id) => nodes.get(id) };
  globalThis.ResizeObserver = class { constructor(callback) { resized = callback; } observe(target) { observed.push(target); } };
  try {
    const render = setupProductionDayCharts();
    const now = '2026-10-16T12:00:00Z';
    const days = [16, 17, 18].map((day, index) => {
      const date = `2026-10-${day}`, sunrise = `${date}T06:0${index}:00Z`, start = Date.parse(sunrise);
      const slots = Array.from({ length: 12 }, (_, hour) => ({ start: new Date(start + hour * 3600000).toISOString(), end: new Date(start + (hour + 1) * 3600000).toISOString(), power_w: 400 + 200 * index }));
      return { date, sunrise, sunset: new Date(start + 12 * 3600000).toISOString(), now, status: 'ok', slots };
    });
    const production = { ...days[0], points: [{ time: now, power_w: 450, active_inverters: 4, expected_inverters: 4 }] };
    render(days, production);
    assert.equal(observed.length, 3);
    for (const [index, id] of ids.entries()) {
      const chart = nodes.get(id), svg = chart.children[0], width = chart.clientWidth;
      assert.equal(svg.attributes.viewBox, `0 0 ${width} 360`);
      assert.equal(svg.attributes.height, '360');
      assert.equal(svg.attributes.preserveAspectRatio, 'xMinYMin meet');
      assert.equal(svg.children.filter((child) => child.attributes['stroke-dasharray'] === '5 4').length, index === 0 ? 1 : 0);
      const target = svg.children.find((child) => child.attributes.role === 'slider');
      assert.equal(Number(target.attributes['aria-valuemin']), Date.parse(days[index].sunrise));
      assert.equal(Number(target.attributes['aria-valuemax']), Date.parse(days[index].sunset));
      target.listeners.pointermove({ clientX: 52 + (width - 70) / 2 });
      assert.match(target.attributes['aria-valuetext'], new RegExp(`Voorspelling: ${400 + 200 * index} W`));
      if (index > 0) {
        assert.doesNotMatch(target.attributes['aria-valuetext'], /Gemeten/);
        assert.equal(svg.children.filter((child) => child.tagName === 'path' && child.attributes.stroke === '#137771').length, 0);
      }
      assert.match(nodes.get(`pv-date-${index}`).textContent, new RegExp(String(16 + index)));
    }
    const small = nodes.get(ids[2]);
    small.clientWidth = 280;
    resized([{ target: small, contentRect: { width: 280 } }]);
    const svg = small.children[0];
    assert.equal(svg.attributes.viewBox, '0 0 280 360');
    const target = svg.children.find((child) => child.attributes.role === 'slider');
    target.listeners.keydown({ key: 'End', preventDefault() {} });
    const cursor = svg.children.find((child) => 'data-chart-cursor' in child.attributes);
    const box = cursor.children.find((child) => 'data-chart-values' in child.attributes).children[0];
    assert.ok(Number(box.attributes.x) >= 52);
    assert.ok(Number(box.attributes.x) + Number(box.attributes.width) <= 262);
    render(days, production);
    assert.ok(ids.every((id) => nodes.get(id).children.length === 1));
  } finally { globalThis.document = previousDocument; globalThis.ResizeObserver = previousObserver; }
});
