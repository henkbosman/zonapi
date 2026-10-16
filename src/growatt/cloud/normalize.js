import { growattTimestamp } from './timestamp.js';

/** Leest een niet-negatieve meetwaarde zonder null naar nul om te zetten; input: bronwaarde, veldnaam en optioneel-vlag; output: getal/null of fout. */
function measurementNumber(value, name, optional = false) {
  if (value === null || value === undefined || value === '') {
    if (optional) return null;
    throw new Error(`Growatt: ${name} ontbreekt`);
  }
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) throw new Error(`Growatt: ${name} ongeldig`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Growatt: ${name} ongeldig`);
  return number;
}

/** Normaliseert de laatste v4-meting van één omvormer; input: API-data, opgevraagde serial/type, ontvangsttijd en tijdzone; output: omvormermeting met echte meettijd of fout. */
export function normalizeGrowattCloud(data, device, receivedMs, timezone) {
  const rows = Array.isArray(data) ? data : data?.[device.device_type];
  if (!Array.isArray(rows)) throw new Error('Growatt: meetreeks ontbreekt in queryLastData');
  const matching = rows.filter((item) => String(item?.serialNum ?? item?.device_sn ?? '').toUpperCase() === device.serial);
  if (!matching.length) throw new Error(`Growatt: geen meting voor ${device.serial}`);
  const dated = matching.map((item) => ({ item, ms: growattTimestamp(item.calendar, timezone) ?? growattTimestamp(item.time ?? item.last_update_time, timezone) }))
    .filter((row) => row.ms !== null).sort((a, b) => b.ms - a.ms);
  if (!dated.length) throw new Error(`Growatt: meettijd ontbreekt of is ongeldig voor ${device.serial}`);
  const { item, ms } = dated[0];
  if (ms > receivedMs + 120000) throw new Error(`Growatt: meettijd ligt in de toekomst voor ${device.serial}`);
  return { serial: device.serial, measured_ms: ms, received_ms: receivedMs, source: 'cloud',
    power_w: measurementNumber(item.pac, 'pac'),
    energy_today_kwh: measurementNumber(item.eacToday ?? item.eToday ?? item.today_energy, 'eacToday', true),
    energy_total_kwh: measurementNumber(item.eacTotal ?? item.eTotal ?? item.total_energy, 'eacTotal', true) };
}
