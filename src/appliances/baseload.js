/** Kiest één netto meetpunt op ingestelde volgorde; input: meterrijen, huidige ms, max-leeftijd, prioriteit; output: rij of null. */
export function primaryNetMeter(meters, now, maxAgeMs = 120000, priority = ['p1', 'kwh']) {
  return priority.map((id) => meters.find((meter) => meter.device === id)).find((meter) => meter && now - meter.measured_ms >= 0 && now - meter.measured_ms <= maxAgeMs) ?? null;
}

/** Schat huisbasislast uit één netto-meter en de gekozen PV-bron; input: repository, meter-id, omvormeraantal, dagen, nu en optionele instellingen/serienummers; output: schatting of null. */
export function estimateBaseload(repository, device, expectedInverters, days, now, settings = null, serials = []) {
  const from = now - days * 86400000;
  const byBucket = new Map();
  const known = new Set(serials.filter(Boolean));
  const rows = settings ? productionHistory(repository, settings, from, now + 1).reverse() : repository.inverterHistory(from);
  for (const row of rows) {
    if (known.size && !known.has(row.serial)) continue;
    const bucket = Math.floor(row.measured_ms / 300000);
    if (!byBucket.has(bucket)) byBucket.set(bucket, new Map());
    if (!byBucket.get(bucket).has(row.serial)) byBucket.get(bucket).set(row.serial, row.power_w);
  }
  const loads = [];
  const used = new Set();
  for (const row of repository.meterHistory(device, from)) {
    const bucket = Math.floor(row.measured_ms / 300000);
    if (used.has(bucket)) continue;
    used.add(bucket);
    const pv = byBucket.get(bucket);
    if (pv?.size !== expectedInverters) continue;
    const load = row.net_power_w + [...pv.values()].reduce((sum, watts) => sum + watts, 0);
    if (load >= 0 && load <= 4000) loads.push(load);
  }
  if (loads.length < 12) return null;
  loads.sort((a, b) => a - b);
  return { power_w: Math.round(loads[Math.floor(loads.length * 0.3)]), source: `${device}_plus_growatt_30th_percentile`, samples: loads.length };
}

/** Bepaalt basislast uit configuratie of uitgelijnde metingen; input: configuratie, repository, nu en optionele serienummers; output: {power_w,source,samples} of null. */
export function getBaseload(settings, repository, now, serials = []) {
  if (settings.advice.baseload_w !== null) return { power_w: settings.advice.baseload_w, source: 'config', samples: 0 };
  for (const device of settings.homewizard.net_meter_priority) {
    const value = estimateBaseload(repository, device, settings.growatt.expected_inverters, settings.advice.history_days, now, settings, serials);
    if (value) return value;
  }
  return null;
}
import { productionHistory } from '../production/source.js';

