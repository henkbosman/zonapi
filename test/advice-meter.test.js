import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMeter, verifyHomeWizardIdentity } from '../src/homewizard/client.js';
import { primaryNetMeter } from '../src/appliances/baseload.js';
import { advise } from '../src/appliances/start-advice.js';

test('HomeWizard v1/v2 hebben dezelfde netto richting en P1 telt niet dubbel met kWh', () => {
  const now = Date.UTC(2026, 9, 14, 10);
  const p1 = normalizeMeter('p1', 'v1', { active_power_w: -135, total_power_export_kwh: 100 }, now);
  const kwh = normalizeMeter('kwh', 'v2', { power_w: -136, energy_export_kwh: 99 }, now);
  assert.equal(primaryNetMeter([p1, kwh], now).net_power_w, -135);
  assert.equal(primaryNetMeter([kwh], now).net_power_w, -136);
  const name = 'appliance/energymeter/5c2fafaabbcc';
  assert.equal(verifyHomeWizardIdentity(name, { subject: { CN: name } }), undefined);
  assert.ok(verifyHomeWizardIdentity(name, { subject: { CN: 'ander-apparaat' } }) instanceof Error);
});

test('advies houdt rekening met volledige machinecyclus en kan voorbij drie uur kijken', () => {
  const now = Date.UTC(2026, 9, 14, 10);
  const profile = { id: 'wasmachine', duration_minutes: 90, min_solar_share: 0.7, steps: [{ duration_minutes: 30, power_w: 800 }, { duration_minutes: 60, power_w: 900 }] };
  const panels = { inverters: [{ id: 'mic', ac_limit_w: 2000 }], groups: [{ id: 'zuid', inverter_id: 'mic', count: 20, wp_per_panel: 400, tilt_deg: 0, azimuth_deg: 180, loss_factor: 0.8 }] };
  const weather = [];
  for (let i = 0; i < 8; i++) weather.push({ start_ms:now + i * 3600000, end_ms:now + (i + 1) * 3600000, ghi:i < 4 ? 0 : 900, dni:i < 4 ? 0 : 700, dhi:i < 4 ? 0 : 200, fetched_ms:now });
  const settings = { weather: { stale_after_hours: 4 }, advice: { search_hours: 6, start_step_minutes: 5, min_solar_share: 0.7, reserve_w: 200 } };
  const result = advise(profile, weather, { now, settings, panels, panelErrors: [], latitude: 52, longitude: 5, baseload: { power_w: 200, source: 'config' } });
  assert.equal(result.status, 'ok');
  assert.equal(result.can_start_now, false);
  assert.ok(Date.parse(result.earliest_start) > now + 3 * 3600000);
  assert.ok(result.earliest.solar_share_percent >= 70);
});
