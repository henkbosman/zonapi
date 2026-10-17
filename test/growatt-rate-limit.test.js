import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfiguration } from '../src/config/load.js';
import { growattCloudConfig } from '../src/growatt/cloud/config.js';
import { createGrowattCloudClient } from '../src/growatt/cloud/client.js';
import { createGrowattCloudPoller } from '../src/growatt/cloud/poller.js';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';

const serials = ['INV0000001', 'INV0000002', 'INV0000003', 'INV0000004'];

/** Bouwt vier cloudomvormers voor de frequentiebeperking; input: geen; output: instellingen en panelen zonder externe verbinding. */
function fixture() {
  const { settings } = loadConfiguration();
  return { settings: { ...settings, growatt: { ...settings.growatt, production_source: 'cloud', cloud: { token: 'test-rate-limit-token' } } },
    panels: { inverters: serials.map((serial) => ({ serial })) } };
}

test('Growatt 102 via HTTP 200 stopt de cyclus en bewaart de wachttijd over een databaseherstart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'zonapi-growatt-102-')), path = join(folder, 'state.sqlite');
  const { settings, panels } = fixture();
  let now = Date.parse('2026-10-16T13:00:00Z'), calls = 0, corrections = 0, limited = true;
  let db = openDatabase(path), repository = createRepository(db);
  const client = createGrowattCloudClient(growattCloudConfig(settings), settings.growatt.cloud.token, {
    clock: () => now, pause: async () => {}, onCall: (row) => repository.saveGrowattCloudCall(row),
    fetcher: async (url, options) => {
      calls++;
      if (limited) return Response.json({ code: 102, message: 'FREQUENTLY_ACCESS' });
      const serial = new URLSearchParams(options.body).get('deviceSn');
      return Response.json({ code: 0, data: { min: [{ serialNum: serial, calendar: now, pac: 250, eacToday: 1, eacTotal: 100 }] } });
    }
  });
  const onMeasurements = (rows) => { corrections++; assert.equal(rows.length, 4); return { status: 'updated' }; };
  try {
    repository.saveCloudInverter({ serial: serials[0], measured_ms: now - 60000, received_ms: now - 60000,
      power_w: 123, energy_today_kwh: 1, energy_total_kwh: 100, frame_id: null });
    let poller = createGrowattCloudPoller({ settings, panels, repository, clock: () => now, environment: {}, client, onMeasurements });
    const failed = await poller.poll();
    assert.equal(failed.reason, 'error');
    assert.equal(failed.measurements, 0);
    assert.equal(calls, 1);
    assert.equal(corrections, 0);
    assert.equal(failed.forecast_correction.status, 'incomplete');
    assert.equal(Date.parse(poller.status().next_fetch), now + 900000);
    assert.match(poller.status().last_error, /code 102: FREQUENTLY_ACCESS/);
    assert.equal(repository.currentCloudInverters()[0].power_w, 123);
    assert.equal(repository.growattTimeline({ limit: 20, offset: 0, type: '', address: '', view: 'cloud' }).rows.length, 1);
    assert.equal((await poller.poll()).reason, 'interval');
    assert.equal(calls, 1);
    await poller.stop();
    db.close(); db = openDatabase(path); repository = createRepository(db);
    poller = createGrowattCloudPoller({ settings, panels, repository, clock: () => now, environment: {}, client, onMeasurements });
    assert.equal((await poller.poll()).reason, 'interval');
    assert.equal(calls, 1);
    now += 900000;
    assert.equal((await poller.poll()).reason, 'error');
    assert.equal(calls, 2);
    assert.equal(Date.parse(poller.status().next_fetch), now + 1800000);
    now += 1800000;
    limited = false;
    assert.equal((await poller.poll()).reason, 'ok');
    assert.equal(repository.currentCloudInverters().length, 4);
    assert.equal(corrections, 1);
    assert.equal(poller.status().last_error, null);
    assert.equal(Date.parse(poller.status().next_fetch), now + 900000);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('Growatt 102 als tekst respecteert langere Retry-After-seconden en HTTP-datum', async () => {
  const { settings, panels } = fixture();
  const now = Date.parse('2026-10-16T13:00:00Z');
  for (const retry of ['1200', new Date(now + 1200000).toUTCString()]) {
    const db = openDatabase(':memory:');
    try {
      const repository = createRepository(db);
      let calls = 0;
      const client = createGrowattCloudClient(growattCloudConfig(settings), settings.growatt.cloud.token, {
        clock: () => now, pause: async () => {}, onCall: repository.saveGrowattCloudCall,
        fetcher: async () => { calls++; return Response.json({ code: '102', message: 'FREQUENTLY_ACCESS' }, { headers: { 'Retry-After': retry } }); }
      });
      const poller = createGrowattCloudPoller({ settings, panels, repository, clock: () => now, environment: {}, client });
      assert.equal((await poller.poll()).reason, 'error');
      assert.equal(calls, 1);
      assert.equal(Date.parse(poller.status().next_fetch), now + 1800000);
      assert.equal((await poller.poll()).reason, 'interval');
      assert.equal(calls, 1);
    } finally { db.close(); }
  }
});
