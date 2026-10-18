import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDatabasePage } from '../public/database.js';

/** Bouwt de gebruikte DOM-onderdelen met echte eventafhandeling; input: tag; output: testelement. */
function node(tagName = 'div') {
  return { tagName, children: [], attributes: {}, listeners: {}, value: '', textContent: '', disabled: false,
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    showModal() { this.open = true; }, close() { this.open = false; }, focus() { this.focused = true; } };
}

function dom() {
  const nodes = new Map();
  return { nodes, document: { createElement: node, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } } };
}
const catalog = { page_sizes: [10, 25, 50, 100, 250, 500], tables: ['metingen', 'logs'].map((name) => ({ name,
  columns: [{ name: 'id', type: 'INTEGER', primary_key: 1 }, { name: 'value', type: 'TEXT', primary_key: 0 }] })) };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const result = (query, values = [[1, '<img src=x onerror=alert(1)>'], [2, null]]) => ({ table: query.get('table'), page: Number(query.get('page')), page_size: Number(query.get('page_size')),
  total_pages: 3, total_rows: 123, filtered_rows: 123, rows: values });

test('databasekeuze opent een popup; kolomfilters, sortering en paginering blijven gekoppeld aan de geselecteerde tabel', async () => {
  const view = dom(), queries = [];
  await setupDatabasePage({ document: view.document, filterDelayMs: 0, request: async (path) => {
    if (path.endsWith('/tables')) return catalog;
    const query = new URL(path, 'http://local').searchParams; queries.push(query); return result(query);
  } });
  const get = (id) => view.nodes.get(id);
  assert.equal(get('table-dialog').open, true); assert.equal(get('table-search').focused, true);
  assert.equal(get('table-options').children.length, 2);
  get('table-options').children[0].listeners.click(); await settle();
  assert.equal(get('table-dialog').open, false); assert.equal(get('table-name').textContent, 'metingen');
  const cells = get('database-rows').children[0].children;
  assert.equal(cells[1].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(cells[1].children[0].children.length, 0);
  assert.equal(get('database-rows').children[1].children[1].children[0].textContent, 'NULL');
  assert.equal(get('next-page').disabled, false);
  get('next-page').listeners.click(); await settle(); assert.equal(queries.at(-1).get('page'), '2');
  const headers = get('database-head').children[0].children;
  headers[0].children[0].listeners.click(); await settle();
  assert.equal(queries.at(-1).get('page'), '1'); assert.equal(queries.at(-1).get('direction'), 'desc');
  assert.equal(headers[0].attributes['aria-sort'], 'descending');
  const filter = headers[1].children[2]; filter.value = '100%_'; filter.listeners.input();
  await new Promise((resolve) => setTimeout(resolve, 5)); await settle();
  assert.deepEqual(JSON.parse(queries.at(-1).get('filters')), [{ column: 'value', value: '100%_' }]);
  get('page-size').value = '100'; get('page-size').listeners.change(); await settle();
  assert.equal(queries.at(-1).get('page_size'), '100'); assert.equal(queries.at(-1).get('page'), '1');
  get('clear-filters').listeners.click(); await settle();
  assert.deepEqual(JSON.parse(queries.at(-1).get('filters')), []); assert.equal(filter.value, '');
  get('last-page').listeners.click(); await settle(); assert.equal(queries.at(-1).get('page'), '3'); assert.equal(get('next-page').disabled, true);
  get('page-number').value = '2'; get('page-form').listeners.submit({ preventDefault() {} }); await settle();
  assert.equal(queries.at(-1).get('page'), '2');
  get('choose-table').listeners.click(); get('table-search').value = 'LOG'; get('table-search').listeners.input();
  assert.equal(get('table-options').children.length, 1);
  get('table-options').children[0].listeners.click(); await settle();
  assert.equal(queries.at(-1).get('table'), 'logs'); assert.equal(queries.at(-1).get('page'), '1'); assert.equal(queries.at(-1).get('direction'), 'asc');
});

test('vertraagde oude antwoorden overschrijven nooit een andere tabel of een nieuw filter', async () => {
  const view = dom(), pending = [];
  await setupDatabasePage({ document: view.document, request: async (path, signal) => {
    if (path.endsWith('/tables')) return catalog;
    return new Promise((resolve, reject) => pending.push({ query: new URL(path, 'http://local').searchParams, signal, resolve, reject }));
  } });
  const get = (id) => view.nodes.get(id);
  get('table-options').children[0].listeners.click();
  get('choose-table').listeners.click(); get('table-options').children[1].listeners.click();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(result(pending[1].query, [[20, 'huidige tabel']])); await settle();
  pending[0].resolve(result(pending[0].query, [[10, 'oude tabel']])); await settle();
  assert.equal(get('table-name').textContent, 'logs');
  assert.equal(get('database-rows').children[0].children[1].children[0].textContent, 'huidige tabel');
  get('refresh-now').listeners.click();
  pending[2].reject(new Error('Verbinding weg')); await settle();
  assert.match(get('database-rows').children[0].children[0].textContent, /Verbinding weg/);
  assert.match(get('connection').textContent, /Fout:/); assert.equal(get('database-table').attributes['aria-busy'], 'false');
});
