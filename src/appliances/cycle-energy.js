import { productionHistory } from '../production/source.js';
import { productionFreshnessMinutes } from '../production/freshness.js';
import { growattCloudConfig } from '../growatt/cloud/config.js';
import { productionSeries } from '../api/production-series.js';

const meterMaxAge = 120000, historyLimit = 100000;

/** Verdeelt socketvermogen volgens de gemeten zonnedekking van het hele huis; input: tijdgeordende cycluspunten, opslag, instellingen, peiltijd en bekende omvormers; output: punten met zonne-/netvermogen of null bij ontbrekende, oude of tegenstrijdige bronnen. */
export function cycleEnergyPoints(points, repository, settings, now, serials = []) {
  if (!points.length) return [];
  const first = points[0].measured_ms, last = Math.min(now, points.at(-1).measured_ms);
  const config = growattCloudConfig(settings);
  const groupSeconds = settings.growatt.overview_group_seconds ?? (config.source === 'shinelink' ? 60 : config.poll_seconds);
  const from = first - Math.max(meterMaxAge, productionFreshnessMinutes(settings.growatt.fresh_minutes, 'cloud') * 60000 + groupSeconds * 1000);
  const rows = productionHistory(repository, settings, from, last + 1, historyLimit).filter((row) => row.received_ms <= now);
  const production = productionSeries(rows, last, null, null, settings.growatt.expected_inverters, settings.growatt.fresh_minutes,
    serials, groupSeconds, false).map((row) => ({ ...row, at: Date.parse(row.time), oldest: Date.parse(row.measured_from) }));
  const meters = [...new Set(settings.homewizard.net_meter_priority ?? ['p1', 'kwh'])].filter((id) => ['p1', 'kwh'].includes(id)).map((id) => ({ index: -1,
    rows: repository.history(id, first - meterMaxAge, last + 1, historyLimit)
      .filter((row) => row.received_ms <= now && Number.isFinite(row.net_power_w)) }));
  let productionIndex = -1;
  return points.map((point) => {
    const at = point.measured_ms;
    while (productionIndex + 1 < production.length && production[productionIndex + 1].at <= at) productionIndex++;
    for (const meter of meters) while (meter.index + 1 < meter.rows.length && meter.rows[meter.index + 1].measured_ms <= at) meter.index++;
    const missing = { ...point, solar_power_w: null, grid_power_w: null };
    if (!Number.isFinite(point.power_w) || point.power_w < 0 || at > now) return missing;
    // Een gemeten programmapauze verbruikt uit beide bronnen exact nul.
    if (point.power_w === 0) return { ...point, solar_power_w: 0, grid_power_w: 0 };
    const pv = production[productionIndex];
    const meter = meters.map((item) => item.rows[item.index]).find((row) => row && at - row.measured_ms <= meterMaxAge);
    if (!pv || !meter || at - pv.oldest > productionFreshnessMinutes(settings.growatt.fresh_minutes, pv.source) * 60000) return missing;
    const household = pv.power_w + meter.net_power_w;
    // Een apparaat kan niet méér gebruiken dan het totale huis; ongelijktijdige metingen geven dan geen betrouwbare verdeling.
    if (household <= 0 || household + 1e-6 < point.power_w) return missing;
    const solar = point.power_w * Math.min(1, Math.max(0, pv.power_w / household));
    return { ...point, solar_power_w: solar, grid_power_w: point.power_w - solar };
  });
}
