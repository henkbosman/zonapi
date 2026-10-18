import { productionHistory } from '../production/source.js';
import { growattCloudConfig } from '../growatt/cloud/config.js';
import { productionSeries } from './production-series.js';

/** Leest de complete gemeten dagtotalen uit de opslag; input: repository, instellingen, panelen, zonstatus en peiltijd; output: daggrenzen en totale vermogenspunten. */
export function productionDayResponse(repository, settings, panels, sunlight, now) {
  const { sunrise, sunset } = sunlight;
  const from = sunrise ? Date.parse(sunrise) : now - 26 * 3600000;
  const to = Math.min(now, sunset ? Date.parse(sunset) : now) + 1;
  const rows = to > from ? productionHistory(repository, settings, from, to, 40000) : [];
  const source = growattCloudConfig(settings).source;
  const groupSeconds = settings.growatt.overview_group_seconds ?? (source === 'shinelink' ? 60 : growattCloudConfig(settings).poll_seconds);
  return { production_source: source, overview_group_seconds: groupSeconds, sunrise: sunrise ?? null, sunset: sunset ?? null,
    now: new Date(now).toISOString(), fresh_minutes: settings.growatt.fresh_minutes,
    points: productionSeries(rows, now, sunrise, sunset, settings.growatt.expected_inverters, settings.growatt.fresh_minutes,
      panels.inverters.map((item) => item.serial), groupSeconds) };
}
