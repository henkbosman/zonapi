import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { loadConfiguration } from '../src/config/load.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { startHttpServer } from '../src/api/http-server.js';

/** Maakt DOM-elementen voor de echte paginamodule; input: tagnaam; output: node met tekst, attributen, kinderen en gebeurtenissen. */
class PageNode {
  /** Initialiseert één testelement; input: tagnaam; output: nieuwe node. */
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.textContent = '';
    this.value = '';
    this.classList = { add() {} };
  }
  /** Voegt nodes toe; input: nodes; output: void. */
  append(...nodes) { this.children.push(...nodes); }
  /** Vervangt de inhoud; input: nodes; output: void. */
  replaceChildren(...nodes) { this.children = nodes; }
  /** Bewaart een attribuut; input: naam en waarde; output: void. */
  setAttribute(name, value) { this.attributes[name] = value; }
  /** Bewaart een gebeurtenisfunctie; input: naam en functie; output: void. */
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

/** Wacht begrensd op een afgeronde paginaverversing; input: voorwaarde; output: Promise<void> of testfout. */
async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await pause(5);
  }
  assert.fail('Paginaverversing niet afgerond');
}

test('Growatt-pagina ververst webomvormers zonder herladen, ook bij een defecte berichtenlijst of bronstatus', async () => {
  const { settings: defaults, panels: examplePanels, panel_errors: panelErrors } = loadConfiguration();
  const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];
  const panels = { ...examplePanels, inverters: examplePanels.inverters.map((item, index) => ({ ...item, serial: serials[index] })) };
  const settings = { ...defaults, http: { host: '127.0.0.1', port: 0 }, growatt: { ...defaults.growatt, production_source: 'cloud' } };
  const db = openDatabase(':memory:');
  const repository = createRepository(db), now = Date.now();
  for (const serial of serials) {
    const row = { serial, measured_ms: now - 360000, received_ms: now - 300000, power_w: 250, energy_today_kwh: 2, energy_total_kwh: 100, frame_id: null };
    repository.saveCloudInverter(row);
    repository.saveInverter({ ...row, measured_ms: now - 120000, power_w: 900 });
  }
  const server = startHttpServer({ settings, panels, panelErrors, repository, weather: { status: () => ({}) }, homewizard: { status: () => ({}) } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = { document: globalThis.document, Node: globalThis.Node, fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  const ids = [...readFileSync(new URL('../public/growatt.html', import.meta.url), 'utf8').matchAll(/id="([^"]+)"/g)];
  const nodes = new Map(ids.map(([, id]) => [id, new PageNode('div')]));
  nodes.get('view-filter').value = 'all';
  let interval, timelineBroken = false, overviewBroken = false;
  try {
    globalThis.Node = PageNode;
    globalThis.document = {
      querySelector: (selector) => nodes.get(selector.slice(1)), getElementById: (id) => nodes.get(id),
      createElement: (tag) => new PageNode(tag), createTextNode: (text) => ({ textContent: text }), addEventListener() {}
    };
    globalThis.setInterval = (callback, milliseconds) => { assert.equal(milliseconds, 15000); interval = callback; return 1; };
    globalThis.fetch = (path, options) => {
      if (timelineBroken && path.startsWith('/api/v1/growatt/timeline')) return Promise.resolve(Response.json({ error: 'testfout' }, { status: 503 }));
      if (overviewBroken && path.startsWith('/api/v1/growatt?')) return Promise.resolve(Response.json({ error: 'testfout' }, { status: 500 }));
      return before.fetch(new URL(path, base), options);
    };
    await import('../public/growatt.js');
    await waitFor(() => nodes.get('connection').textContent.startsWith('Bijgewerkt'));
    assert.equal(nodes.get('power').textContent, '1.0 kW');
    assert.equal(nodes.get('inverters').children.length, 4);
    assert.deepEqual(nodes.get('inverters').children[0].children.slice(0, 3).map((cell) => cell.textContent), [serials[0], 'Web-API', '250 W']);
    const firstReceipt = nodes.get('inverters').children[0].children[6].textContent;

    for (const serial of serials) repository.saveCloudInverter({ serial, measured_ms: now - 60000, received_ms: now,
      power_w: 350, energy_today_kwh: 3.5, energy_total_kwh: 101.5 });
    timelineBroken = true;
    interval();
    await waitFor(() => nodes.get('connection').textContent === 'Berichten: HTTP 503');
    assert.equal(nodes.get('power').textContent, '1.4 kW');
    assert.equal(nodes.get('active').textContent, '4/4');
    for (const row of nodes.get('inverters').children) {
      assert.equal(row.children.length, 8);
      assert.equal(row.children[1].textContent, 'Web-API');
      assert.equal(row.children[2].textContent, '350 W');
      assert.equal(row.children[3].textContent, '3.5 kWh');
      assert.notEqual(row.children[6].textContent, firstReceipt);
      assert.equal(row.children[7].textContent, 'Actueel');
    }

    for (const serial of serials) repository.saveCloudInverter({ serial, measured_ms: now - 30000, received_ms: now + 1000,
      power_w: 400, energy_today_kwh: 3.6, energy_total_kwh: 101.6 });
    overviewBroken = true;
    nodes.get('refresh-now').listeners.click();
    await waitFor(() => nodes.get('connection').textContent === 'Bronstatus: HTTP 500 · Berichten: HTTP 503');
    assert.equal(nodes.get('power').textContent, '1.6 kW');
    assert.equal(nodes.get('inverters').children[0].children[2].textContent, '400 W');
  } finally {
    Object.assign(globalThis, before);
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
