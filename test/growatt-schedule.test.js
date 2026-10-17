import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfiguration } from '../src/config/load.js';
import { growattCloudConfig } from '../src/growatt/cloud/config.js';
import { createGrowattCloudPoller } from '../src/growatt/cloud/poller.js';
import { CLOUD_QUARTER_MS, nextQuarter, quarterAtOrAfter, restoredQuarter } from '../src/growatt/cloud/schedule.js';
import { currentProductionRows } from '../src/production/source.js';
import { productionResponse } from '../src/api/measurements.js';
import { renderGrowattCloud } from '../public/growatt-cloud.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';

const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];
const at = (time) => Date.parse(`2026-10-16T${time}Z`);
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Maakt een volledige opslagrij; input: serienummer, meet-/ontvangsttijd en vermogen; output: omvormermeting met optionele velden expliciet op null. */
function measurement(serial, measured, received = measured, power = 100) {
  return { serial, measured_ms: measured, received_ms: received, power_w: power, energy_today_kwh: null, energy_total_kwh: null, frame_id: null };
}

/** Bouwt een klok met handmatig afvuurbare timers en echte tijdelijke opslag; input: testcontext en tijd; output: pollercontext zonder netwerk of echte wachttijden. */
function fixture(t, time = '13:07:08.000', source = 'cloud', cloud = {}) {
  const { settings: defaults } = loadConfiguration();
  const settings = { ...defaults, location: { latitude: 52, longitude: 5 }, growatt: { ...defaults.growatt,
    production_source: source, cloud: { token: 'test-schedule-token', poll_seconds: 300, ...cloud } } };
  const db = openDatabase(':memory:'), repository = createRepository(db);
  const context = { now: at(time), calls: [], handles: new Map(), delay: 0, pollers: [] };
  let id = 0;
  const timers = {
    setTimeout(callback, delay) { const handle = ++id; context.handles.set(handle, { when: context.now + delay, callback }); return handle; },
    clearTimeout(handle) { context.handles.delete(handle); }
  };
  const client = { read: async (device) => {
    const received = context.now;
    context.calls.push({ serial: device.serial, time: received });
    context.now += context.delay;
    return { serial: device.serial, source: 'cloud', measured_ms: received - 73456, received_ms: context.now,
      power_w: 250, energy_today_kwh: 1, energy_total_kwh: 100 };
  } };
  context.make = (options = {}) => {
    const poller = createGrowattCloudPoller({ settings, panels: { inverters: serials.map((serial) => ({ serial })) },
      repository, clock: () => context.now, environment: {}, timers, client, ...options });
    context.pollers.push(poller);
    return poller;
  };
  context.fire = async (time) => {
    const [handle, timer] = [...context.handles].sort((a, b) => a[1].when - b[1].when)[0];
    context.now = typeof time === 'number' ? time : at(time);
    assert.ok(context.now >= timer.when, 'timer mag niet te vroeg afgaan');
    context.handles.delete(handle);
    timer.callback();
    await settled();
  };
  context.deadline = () => [...context.handles.values()].map((timer) => timer.when);
  t.after(async () => { for (const poller of context.pollers) await poller.stop(); db.close(); });
  return Object.assign(context, { settings, repository });
}

test('achtergrondtimer haalt vier keer per uur op, zonder verschuiving door antwoordduur of dubbele start', async (t) => {
  const f = fixture(t), poller = f.make();
  f.delay = 8750;
  poller.start(); poller.start();
  await settled();
  assert.equal(growattCloudConfig(f.settings).poll_seconds, 900);
  assert.equal(poller.status().poll_schedule, 'quarter_hour');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.deadline(), [at('13:15:00.000')]);
  for (const time of ['13:15:00.123', '13:30:00.000', '13:45:00.000', '14:00:00.000']) {
    const start = at(time);
    await f.fire(time);
    assert.equal(f.calls.at(-4).time, start);
    assert.deepEqual(f.calls.slice(-4).map((row) => row.serial), serials);
    assert.deepEqual(f.deadline(), [nextQuarter(start)]);
    assert.equal(Date.parse(poller.status().next_fetch), nextQuarter(start));
    assert.equal(f.repository.currentCloudInverters()[0].measured_ms, start - 73456);
  }
  await poller.stop();
  assert.equal(f.handles.size, 0);
  assert.equal(f.calls.length, 16);
});

test('handmatig ophalen en herstart respecteren het volgende klokkwartier zonder extra API-ronde', async (t) => {
  const f = fixture(t), poller = f.make();
  assert.equal((await poller.poll()).reason, 'interval');
  f.now = at('13:15:00.000');
  assert.equal((await poller.poll()).reason, 'ok');
  assert.equal((await poller.poll()).reason, 'interval');
  await poller.stop();
  f.now = at('13:19:40.000');
  const restarted = f.make();
  restarted.start();
  await settled();
  assert.deepEqual(f.deadline(), [at('13:30:00.000')]);
  assert.equal((await restarted.poll()).reason, 'interval');
  await f.fire('13:30:00.000');
  assert.equal(f.calls.length, 8);
});

test('na stilstand of een lange timervertraging worden gemiste kwartieren niet ingehaald', async (t) => {
  const f = fixture(t), poller = f.make();
  poller.start(); await settled();
  await f.fire('13:17:00.000');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.deadline(), [at('13:30:00.000')]);
  await f.fire('14:00:00.020');
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.deadline(), [at('14:15:00.000')]);
});

test('een cyclus die over een kwartier heen duurt start geen overlappende of inhaalcyclus', async (t) => {
  const f = fixture(t), poller = f.make();
  f.delay = 5 * 60000;
  poller.start(); await settled();
  await f.fire('13:15:00.000');
  assert.equal(f.calls.length, 4);
  assert.equal(f.now, at('13:35:00.000'));
  assert.deepEqual(f.deadline(), [at('13:45:00.000')]);
});

test('een lopend verzoek blokkeert handmatig ophalen en krijgt na voltooiing weer een vaste deadline', async (t) => {
  const f = fixture(t, '13:00:00.000');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const poller = f.make({ client: { read: async (device) => {
    await held;
    return measurement(device.serial, f.now - 1000, f.now);
  } } });
  const pending = poller.poll();
  assert.equal((await poller.poll()).reason, 'busy');
  f.now = at('13:16:00.000'); release();
  assert.equal((await pending).reason, 'ok');
  assert.equal(poller.status().next_fetch, new Date(at('13:30:00.000')).toISOString());
});

test('Retry-After slaat kwartieren over en hervat na een herstart op een geldig klokkwartier', async (t) => {
  const f = fixture(t, '13:00:00.000');
  let limited = true;
  const client = { read: async (device) => {
    f.calls.push({ serial: device.serial, time: f.now });
    f.now += 3000;
    if (limited) throw Object.assign(new Error('FREQUENTLY_ACCESS'), { api_code: 102, retry_after_ms: 20 * 60000 });
    return measurement(device.serial, f.now, f.now, 200);
  } };
  const poller = f.make({ client });
  poller.start(); await settled();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.deadline(), [at('13:30:00.000')]);
  await poller.stop();
  f.now = at('13:15:00.000');
  const restarted = f.make({ client });
  restarted.start(); await settled();
  assert.equal((await restarted.poll()).reason, 'interval');
  assert.deepEqual(f.deadline(), [at('13:30:00.000')]);
  limited = false;
  await f.fire('13:30:00.000');
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.deadline(), [at('13:45:00.000')]);
});

test('automatische bronkeuze slaat een lokaal actuele ronde over en controleert op het volgende kwartier', async (t) => {
  const f = fixture(t, '13:00:00.000', 'auto'), poller = f.make();
  for (const serial of serials) f.repository.saveInverter(measurement(serial, f.now));
  poller.start(); await settled();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.deadline(), [at('13:15:00.000')]);
  await f.fire('13:15:00.000');
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.deadline(), [at('13:30:00.000')]);
});

test('alleen daglicht rondt zonsopkomst naar een klokkwartier af en haalt na zonsondergang niet op', async (t) => {
  const f = fixture(t, '05:00:00.000', 'cloud', { daylight_only: true }), poller = f.make();
  f.repository.saveSun('2026-10-16', at('05:13:20.000'), at('17:01:00.000'), 'test', f.now);
  f.repository.saveSun('2026-10-17', Date.parse('2026-10-17T05:14:00Z'), Date.parse('2026-10-17T17:00:00Z'), 'test', f.now);
  poller.start(); await settled();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.deadline(), [at('05:15:00.000')]);
  await f.fire('05:15:00.000');
  assert.equal(f.calls.length, 4);
  await f.fire('17:15:00.000');
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.deadline(), [Date.parse('2026-10-17T05:15:00Z')]);
});

test('herstel van de oude intervalplanning behoudt frequentiebeperkingen en voorkomt een dubbele kwartierpoging', () => {
  assert.equal(restoredQuarter({}, at('13:07:00.000')), at('13:15:00.000'));
  assert.equal(restoredQuarter({ last_attempt_ms: at('13:14:00.000'), next_ms: at('13:19:00.000') }, at('13:14:01.000')), at('13:30:00.000'));
  assert.equal(restoredQuarter({ failures: 1, next_ms: at('13:22:00.000') }, at('13:15:00.000')), at('13:30:00.000'));
  assert.equal(restoredQuarter({ retry_not_before_ms: at('13:35:00.000') }, at('13:30:00.000')), at('13:45:00.000'));
  assert.equal(restoredQuarter({ last_slot_ms: at('13:15:00.000') }, at('13:15:00.000')), at('13:30:00.000'));
  assert.equal(restoredQuarter({ next_ms: at('18:07:00.000'), failures: 0 }, at('13:07:00.000')), at('13:15:00.000'));
});

test('klokplanning blijft op Nederlandse kwartieren bij uur- en dagwisseling en zomer-/wintertijd', () => {
  const formatter = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', minute: '2-digit', second: '2-digit' });
  for (const value of ['2026-10-16T23:59:59.999Z', '2026-03-29T00:59:59.999Z', '2026-10-25T00:59:59.999Z']) {
    const before = Date.parse(value), next = nextQuarter(before);
    assert.equal(next, before + 1);
    for (let i = 0; i < 6; i++) {
      const slot = next + i * CLOUD_QUARTER_MS;
      const parts = Object.fromEntries(formatter.formatToParts(new Date(slot)).map((part) => [part.type, part.value]));
      assert.ok(['00', '15', '30', '45'].includes(parts.minute));
      assert.equal(parts.second, '00');
      assert.equal(quarterAtOrAfter(slot), slot);
    }
  }
});

test('kwartiercloudmetingen krijgen minstens twintig minuten versheid; lokale en toekomstige metingen behouden hun grens', (t) => {
  const f = fixture(t, '13:14:00.000', 'auto');
  for (const serial of serials) {
    f.repository.saveCloudInverter(measurement(serial, at('12:55:00.000'), at('13:00:00.000'), 200));
    f.repository.saveInverter(measurement(serial, at('13:00:00.000')));
  }
  const rows = currentProductionRows(f.repository, f.settings, f.now);
  assert.ok(rows.every((row) => row.source === 'cloud'));
  assert.equal(productionResponse(rows, 4, 12, f.now).power_w, 800);
  assert.equal(productionResponse(rows, 4, 12, at('13:15:00.001')).active_inverters, 0);
  assert.equal(productionResponse(rows, 4, 30, at('13:20:00.000')).power_w, 800);
  assert.equal(productionResponse(rows, 4, 12, at('12:54:59.999')).active_inverters, 0);
  const local = f.repository.currentInverters();
  assert.equal(productionResponse(local, 4, 12, f.now).active_inverters, 0);
});

test('de Growatt-pagina toont vaste klokkwartieren en de serverdeadline', (t) => {
  const nodes = new Map();
  const previous = globalThis.document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  globalThis.document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', replaceChildren() {} });
    return nodes.get(id);
  } };
  renderGrowattCloud({ enabled: true, configured: true, state: 'waiting', poll_seconds: 900,
    poll_schedule: 'quarter_hour', next_fetch: '2026-10-16T13:15:00Z' });
  assert.equal(nodes.get('cloud-interval').textContent, ':00 · :15 · :30 · :45');
  assert.match(nodes.get('cloud-next').textContent, /15:15:00/);
});
