import { primaryNetMeter } from '../appliances/baseload.js';

/** Berekent betrouwbaar huidig PV-vermogen uit afzonderlijke omvormers; input: rijen, aantal, leeftijd, nu, bekende serials; output: totaalsom of partial. */
export function productionResponse(rows, expected, freshnessMinutes, now, configuredSerials = []) {
  const known = configuredSerials.filter(Boolean);
  const selected = known.length ? rows.filter((row) => known.includes(row.serial)) : rows;
  const inverters = selected.map((row) => ({ serial: row.serial, power_w: row.power_w, energy_today_kwh: row.energy_today_kwh, energy_total_kwh: row.energy_total_kwh, measured_at: new Date(row.measured_ms).toISOString(), received_at: new Date(row.received_ms).toISOString(), fresh: now - row.measured_ms >= 0 && now - row.measured_ms <= freshnessMinutes * 60000 }));
  for (const serial of known) {
    if (!inverters.some((item) => item.serial === serial)) inverters.push({ serial, power_w: null, energy_today_kwh: null, energy_total_kwh: null, measured_at: null, received_at: null, fresh: false });
  }
  const fresh = inverters.filter((item) => item.fresh);
  const complete = fresh.length === expected && inverters.length === expected;
  return { status: complete ? 'ok' : 'partial', expected_inverters: expected, active_inverters: fresh.length, power_w: complete ? Math.round(fresh.reduce((sum, item) => sum + item.power_w, 0) * 10) / 10 : null, inverters, ignored_unmapped: rows.length - selected.length };
}

/** Geeft P1 en kWh op hetzelfde netto meetpunt met één voorkeursmeting; input: meterrijen, nu en prioriteit; output: meterstatus zonder dubbeltelling. */
export function metersResponse(rows, now, priority = ['p1', 'kwh']) {
  const meters = rows.map((item) => ({ device: item.device, net_power_w: item.net_power_w, import_kwh: item.import_kwh, export_kwh: item.export_kwh, measured_at: new Date(item.measured_ms).toISOString(), fresh: now - item.measured_ms >= 0 && now - item.measured_ms < 120000 }));
  const chosen = primaryNetMeter(rows, now, 120000, priority);
  return { status: chosen ? 'ok' : 'stale_or_unavailable', connection: 'one_phase', relation: 'p1_and_kwh_same_net_point_do_not_sum', selected_device: chosen?.device ?? null, net_power_w: chosen?.net_power_w ?? null, meters };
}
