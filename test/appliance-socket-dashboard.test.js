import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDailyAdvice } from '../public/dashboard-daily-advice.js';
import { drawProductionChart } from '../public/dashboard-production-chart.js';

/** Bouwt DOM-nodes voor kaart- en grafiekgedrag; input: tagnaam; output: testnode. */
function element(tagName) {
  return { tagName, children: [], attributes: {}, listeners: {}, textContent: '', className: '', clientWidth: 500,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, listener) { this.listeners[name] = listener; }, getBoundingClientRect() { return { left: 0, width: 500 }; } };
}

/** Verzamelt de getoonde tekst uit een testboom; input: node; output: tekst. */
function text(node) { return [node.textContent, ...node.children.map(text)].filter(Boolean).join(' '); }

test('een draaiend apparaat krijgt vermogen en starttijd, vandaag Bezig en morgen het gewone startadvies', () => {
  const before = globalThis.document;
  globalThis.document = { createElement: (tag) => element(tag) };
  try {
    const container = element('div');
    const daily = { days: [17, 18].map((day) => ({ date: `2026-10-${day}`, appliances: [
      { id: 'wasmachine', status: 'ok', earliest_start: `2026-10-${day}T10:00:00Z`, can_start_now: day === 17, earliest: { solar_share_percent: 85 } }
    ] })) };
    const profile = { id: 'wasmachine', name: 'Wasmachine', duration_minutes: 90,
      activity: { configured: true, state: 'running', running: true, power_w: 1432, started_at: '2026-10-17T09:03:00Z' } };
    renderDailyAdvice(container, [profile], daily);
    const card = container.children[0], message = text(card);
    assert.match(message, /Actief · 1432 W/);
    assert.match(message, /Actief sinds 11:03/);
    assert.doesNotMatch(message, /Nu ·/);
    assert.match(message, /Bezig/);
    assert.match(message, /12:00/);
    assert.equal(card.children.find((node) => node.className === 'appliance-activity activity-running').attributes.role, 'status');
    profile.activity = { configured: true, state: 'unavailable', running: null, power_w: null, error: 'time-out' };
    renderDailyAdvice(container, [profile], daily);
    assert.match(text(container), /Socket niet bereikbaar/);
    assert.doesNotMatch(text(container), /Bezig|Actief sinds/);
    assert.match(text(container), /Nu · 12:00/);
    assert.equal(container.children[0].children.find((node) => node.className.includes('activity-unavailable')).title, 'time-out');
  } finally { globalThis.document = before; }
});

test('apparaten zonder socket houden hun advies; een pending start toont nog geen bevestigde aanstatus', () => {
  const before = globalThis.document;
  globalThis.document = { createElement: (tag) => element(tag) };
  try {
    const container = element('div');
    const profiles = [{ id: 'droger', name: 'Droger', duration_minutes: 90 },
      { id: 'wasmachine', name: 'Wasmachine', duration_minutes: 120, activity: { configured: true, state: 'starting', running: false, power_w: 20 } }];
    renderDailyAdvice(container, profiles, { days: [{ date: '2026-10-17', appliances: [] }] });
    assert.doesNotMatch(text(container.children[0]), /Socket|Actief|Start wordt herkend/);
    assert.match(text(container.children[1]), /Start wordt herkend · 20 W/);
    assert.doesNotMatch(text(container.children[1]), /Bezig|Actief sinds/);
    assert.match(text(container.children[0]), /Geen advies/);
  } finally { globalThis.document = before; }
});

test('de rode basislast blijft zichtbaar boven de voorspelling; nul en ontbrekende basislast worden onderscheiden', () => {
  const before = globalThis.document;
  globalThis.document = { createElementNS: (_, tag) => element(tag), createElement: (tag) => element(tag) };
  try {
    const day = { sunrise: '2026-10-17T06:00:00Z', sunset: '2026-10-17T18:00:00Z', now: '2026-10-17T05:00:00Z', points: [] };
    const slots = [{ start: day.sunrise, end: day.sunset, power_w: 400 }];
    const container = element('div');
    drawProductionChart(container, day, slots, { baseloadW: 2400 });
    const svg = container.children[0], line = svg.children.find((node) => node.attributes['data-baseload-w'] === '2400');
    assert.equal(line.attributes.stroke, '#c64040');
    assert.equal(line.attributes.y1, line.attributes.y2);
    assert.ok(Number(line.attributes.y1) >= 24 && Number(line.attributes.y1) <= 312);
    assert.ok(svg.children.some((node) => node.textContent === '2.5 kW'));
    const target = svg.children.find((node) => node.attributes.role === 'slider');
    target.listeners.focus();
    assert.match(target.attributes['aria-valuetext'], /Basislast: 2.400 W/);
    drawProductionChart(container, day, slots, { baseloadW: 0 });
    assert.ok(container.children[0].children.some((node) => node.attributes['data-baseload-w'] === '0'));
    drawProductionChart(container, day, slots, { baseloadW: null });
    assert.ok(container.children[0].children.every((node) => !('data-baseload-w' in node.attributes)));
  } finally { globalThis.document = before; }
});
