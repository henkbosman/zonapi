import { growattCloudConfig } from '../growatt/cloud/config.js';
import { productionFreshnessMinutes } from './freshness.js';

/** Selecteert één meting per serienummer; input: lokale/cloudrijen, bronkeuze, versheid en peiltijd; output: rijen met expliciete bron, auto kiest recente lokale data vóór cloud. */
export function selectCurrentProduction(localRows, cloudRows, source, freshnessMinutes, now) {
  const local = new Map(localRows.map((row) => [row.serial, { ...row, source: 'shinelink' }]));
  const cloud = new Map(cloudRows.map((row) => [row.serial, { ...row, source: 'cloud' }]));
  if (source === 'shinelink') return [...local.values()];
  if (source === 'cloud') return [...cloud.values()];
  const fresh = (row) => row && now >= row.measured_ms && now - row.measured_ms <= productionFreshnessMinutes(freshnessMinutes, row.source) * 60000;
  return [...new Set([...local.keys(), ...cloud.keys()])].map((serial) => {
    const localRow = local.get(serial), cloudRow = cloud.get(serial);
    if (fresh(localRow)) return localRow;
    if (fresh(cloudRow)) return cloudRow;
    return !localRow ? cloudRow : !cloudRow ? localRow : localRow.measured_ms >= cloudRow.measured_ms ? localRow : cloudRow;
  });
}

/** Leest de actuele gekozen PV-bron zonder netwerkverzoek; input: repository, instellingen en peiltijd; output: maximaal één rij per omvormer. */
export function currentProductionRows(repository, settings, now) {
  const source = growattCloudConfig(settings).source;
  return selectCurrentProduction(source === 'cloud' ? [] : repository.currentInverters(), source === 'shinelink' ? [] : repository.currentCloudInverters(), source, settings.growatt.fresh_minutes, now);
}

/** Combineert historische bronnen volgens dezelfde voorkeur als actuele metingen; input: repository, instellingen, tijdvenster, limiet en optionele bronkeuze; output: chronologische metingen zonder dubbele bron op één tijdstip. */
export function productionHistory(repository, settings, from, to, limit = 40000, source = growattCloudConfig(settings).source) {
  const local = source === 'cloud' ? [] : repository.history('inverter', from, to, limit).map((row) => ({ ...row, source: 'shinelink' }));
  const cloud = source === 'shinelink' ? [] : repository.cloudInverterHistory(from, to, limit);
  if (source === 'shinelink') return local;
  if (source === 'cloud') return cloud;
  const history = [...local, ...cloud].sort((a, b) => a.received_ms - b.received_ms || a.measured_ms - b.measured_ms || (a.source === b.source ? 0 : a.source === 'shinelink' ? -1 : 1));
  const locals = new Map(), clouds = new Map(), selected = new Map();
  for (const row of history) {
    const target = row.source === 'shinelink' ? locals : clouds;
    if (!target.has(row.serial) || target.get(row.serial).measured_ms <= row.measured_ms) target.set(row.serial, row);
    const chosen = selectCurrentProduction(locals.has(row.serial) ? [locals.get(row.serial)] : [], clouds.has(row.serial) ? [clouds.get(row.serial)] : [], 'auto', settings.growatt.fresh_minutes, row.received_ms)[0];
    const key = `${chosen.serial}:${chosen.measured_ms}`;
    selected.set(key, chosen);
  }
  return [...selected.values()].sort((a, b) => a.measured_ms - b.measured_ms).slice(0, limit);
}
