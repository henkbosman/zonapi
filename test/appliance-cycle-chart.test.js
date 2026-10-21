import test from 'node:test';
import assert from 'node:assert/strict';
import { drawApplianceCycleChart, elapsedTime } from '../public/appliance-cycle-chart.js';
import { setupApplianceCharts } from '../public/dashboard-appliance-charts.js';

/** Bouwt DOM-nodes met cursor- en timerondersteuning; input: tag; output: testnode. */
function element(tagName) {
  return { tagName, attributes: {}, children: [], listeners: {}, textContent: '', className: '', clientWidth: 500,
    setAttribute(name, value) { this.attributes[name] = String(value); }, append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; }, addEventListener(name, listener) { this.listeners[name] = listener; },
    getBoundingClientRect() { return { left: 0, width: this.clientWidth }; } };
}

/** Maakt twee cycli met verschillende startdatums maar dezelfde verstreken tijdas; input: geen; output: grafiekdata. */
function fixture() {
  const run = (powers, state, started_at) => ({ state, complete: true, started_at, duration_seconds: (powers.length - 1) * 60,
    max_gap_seconds: 120, points: powers.map((power_w, index) => ({ elapsed_seconds: index * 60, power_w })) });
  return { id: 'wasmachine', name: 'Wasmachine', configured: true, live: true, elapsed_seconds: 120, fresh_seconds: 120,
    activity: { measured_at: '2026-10-25T01:30:00Z' }, current: run([100, 1900, 150], 'active', '2026-10-25T01:28:00Z'),
    previous: run([200, 1800, 200, 0], 'completed', '2026-10-24T10:00:00Z') };
}

test('apparaatgrafiek lijnt vorige cyclus uit op start, toont beide vermogens en verstreken tijd zonder tijdzoneverschuiving', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: element };
  try {
    const container = element('div'), data = fixture();
    const update = drawApplianceCycleChart(container, data);
    const svg = container.children[0];
    assert.equal(svg.attributes.viewBox, '0 0 500 360');
    const paths = svg.children.filter((node) => node.tagName === 'path');
    assert.equal(paths.length, 2);
    assert.ok(paths.every((node) => node.attributes.d.startsWith('M56.0,')));
    const progress = svg.children.find((node) => 'data-cycle-progress' in node.attributes);
    assert.equal(Number(progress.attributes.x1), 340);
    assert.equal(progress.attributes.x1, progress.attributes.x2);
    assert.match(svg.children.find((node) => 'data-cycle-elapsed' in node.attributes).textContent, /Verstreken 00:02:00/);
    const target = svg.children.find((node) => node.attributes.role === 'slider');
    target.listeners.keydown({ key: 'End', preventDefault() {} });
    assert.match(target.attributes['aria-valuetext'], /00:03:00, Gemeten: —, Vorige cyclus: 0 W/);
    target.listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
    assert.match(target.attributes['aria-valuetext'], /00:02:00, Gemeten: 150 W, Vorige cyclus: 200 W/);
    update(150);
    assert.equal(Number(progress.attributes.x1), 411);
    assert.equal(container.children[0], svg);
    assert.equal(elapsedTime(4500000), '01:15:00');
  } finally { globalThis.document = before; }
});

test('meetgaten blijven open en een ontbrekende vorige cyclus wordt niet verzonnen; lege en smalle grafieken blijven bruikbaar', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: element };
  try {
    const container = element('div'); container.clientWidth = 280;
    const data = fixture(); data.previous = null;
    data.current.points = [{ elapsed_seconds: 0, power_w: 100 }, { elapsed_seconds: 60, power_w: 300 }, { elapsed_seconds: 400, power_w: 500 }];
    data.current.duration_seconds = 400; data.elapsed_seconds = 400;
    drawApplianceCycleChart(container, data);
    const svg = container.children[0], path = svg.children.find((node) => node.tagName === 'path');
    assert.equal(svg.attributes.width, '280');
    assert.equal((path.attributes.d.match(/M/g) ?? []).length, 2);
    const target = svg.children.find((node) => node.attributes.role === 'slider');
    target.listeners.keydown({ key: 'End', preventDefault() {} });
    assert.match(target.attributes['aria-valuetext'], /Vorige cyclus: —/);
    const cursor = svg.children.find((node) => 'data-chart-cursor' in node.attributes);
    const box = cursor.children.find((node) => 'data-chart-values' in node.attributes).children[0];
    assert.ok(Number(box.attributes.x) >= 56 && Number(box.attributes.x) + Number(box.attributes.width) <= 262);
    drawApplianceCycleChart(container, { ...data, current: null });
    assert.match(container.children[0].textContent, /Nog geen cyclus gemeten/);
    drawApplianceCycleChart(container, { ...data, current: null, configured: false });
    assert.match(container.children[0].textContent, /Energy Socket/);
  } finally { globalThis.document = before; }
});

test('groene en rode bronlijnen volgen de huidige cyclus, tonen cursorwaarden en overbruggen geen ontbrekende bronmeting', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: element };
  try {
    for (const width of [280, 500, 1180]) {
      const container = element('div'); container.clientWidth = width;
      const data = fixture();
      data.current.duration_seconds = 240;
      data.current.points = [0, 60, 120, 180, 240].map((elapsed_seconds, index) => ({ elapsed_seconds, power_w: 1000,
        solar_power_w: index === 2 ? null : 400, grid_power_w: index === 2 ? null : 600 }));
      drawApplianceCycleChart(container, data);
      const svg = container.children[0];
      const paths = svg.children.filter((node) => node.tagName === 'path');
      assert.equal(paths.length, 4);
      for (const [series, color] of [['solar', '#2e9d44'], ['grid', '#d84945']]) {
        const path = paths.find((node) => node.attributes['data-cycle-series'] === series);
        assert.equal(path.attributes.stroke, color);
        assert.equal((path.attributes.d.match(/M/g) ?? []).length, 2);
      }
      const target = svg.children.find((node) => node.attributes.role === 'slider');
      target.listeners.keydown({ key: 'End', preventDefault() {} });
      assert.match(target.attributes['aria-valuetext'], /Uit zon: 400 W, Uit net: 600 W/);
      target.listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
      target.listeners.keydown({ key: 'ArrowLeft', preventDefault() {} });
      assert.match(target.attributes['aria-valuetext'], /Gemeten: 1\.000 W.*Uit zon: —, Uit net: —/);
      const cursor = svg.children.find((node) => 'data-chart-cursor' in node.attributes);
      const box = cursor.children.find((node) => 'data-chart-values' in node.attributes).children[0];
      assert.ok(Number(box.attributes.x) >= 56 && Number(box.attributes.x) + Number(box.attributes.width) <= width - 18);
      assert.equal(Number(box.attributes.height), 106);
    }
  } finally { globalThis.document = before; }
});

test('de secondewijzer beweegt zonder opnieuw te tekenen of op te halen en bevriest wanneer socketmetingen te oud zijn', () => {
  const old = { document: globalThis.document, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, ResizeObserver: globalThis.ResizeObserver };
  let tick, cleared = false, clock = 1000;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: element };
  globalThis.setInterval = (callback) => { tick = callback; return 1; };
  globalThis.clearInterval = () => { cleared = true; };
  globalThis.ResizeObserver = undefined;
  let render;
  try {
    const container = element('div'), data = fixture();
    render = setupApplianceCharts(container, () => clock);
    render({ generated_at: data.activity.measured_at, appliances: [data] });
    const card = container.children[0], chart = card.children.find((node) => node.className === 'chart'), svg = chart.children[0];
    const legend = card.children.find((node) => node.className === 'chart-legend');
    assert.equal(legend.children.length, 4);
    assert.ok(legend.children.some((node) => node.children[1].textContent === 'Verbruik uit zon'));
    assert.ok(legend.children.some((node) => node.children[1].textContent === 'Verbruik uit net'));
    assert.match(card.children.find((node) => node.className.includes('cycle-note')).textContent, /naar verhouding van het gemeten huisverbruik/);
    const line = svg.children.find((node) => 'data-cycle-progress' in node.attributes), before = Number(line.attributes.x1);
    clock += 15000; tick();
    assert.ok(Number(line.attributes.x1) > before);
    assert.equal(chart.children[0], svg);
    assert.match(svg.children.find((node) => 'data-cycle-elapsed' in node.attributes).textContent, /00:02:15/);
    clock += 120000; tick();
    assert.match(svg.children.find((node) => 'data-cycle-elapsed' in node.attributes).textContent, /Gemeten tot 00:02:00/);
    assert.equal(Number(line.attributes.x1), before);
    render({ generated_at: data.activity.measured_at, appliances: [data] });
    assert.equal(container.children.length, 1);
  } finally {
    render?.stop();
    assert.equal(cleared, true);
    Object.assign(globalThis, old);
  }
});
