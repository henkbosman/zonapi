import { estimatePv } from './model.js';
import { getCalibrationFactor } from './calibration.js';
import { createPvForecastModel } from './forecast-model.js';

/** Leest de oorspronkelijke PV-prognose op de Growatt-meettijd via bronmiddelpunten; input: opslag, instellingen, panelen en meettijd; output: {power_w,fetched_ms} of null bij ontbrekende brondata, onafhankelijk van eerdere correcties. */
export function basePvAtTime(repository, settings, panels, at) {
  const rows = repository.forecast(at - 75 * 60000, at + 75 * 60000);
  const samples = rows.map((row) => ({ row, at: (row.start_ms + row.end_ms) / 2,
    power_w: estimatePv(row, panels, settings.location.latitude, settings.location.longitude, getCalibrationFactor(settings)).power_w }));
  const covering = samples.find((item) => item.row.start_ms <= at && item.row.end_ms > at);
  if (!covering) return null;
  const exact = samples.find((item) => item.at === at);
  if (exact) return { power_w: exact.power_w, fetched_ms: exact.row.fetched_ms };
  const left = samples.filter((item) => item.at < at).at(-1), right = samples.find((item) => item.at > at);
  if (left && right && right.at - left.at <= 75 * 60000 && right.row.start_ms <= left.row.end_ms) {
    return { power_w: left.power_w + (right.power_w - left.power_w) * (at - left.at) / (right.at - left.at), fetched_ms: Math.min(left.row.fetched_ms, right.row.fetched_ms) };
  }
  return { power_w: covering.power_w, fetched_ms: covering.row.fetched_ms };
}

/** Leest dezelfde ongecorrigeerde kwartierbasis als de grafiek; input: opslag, instellingen, panelen, bronklok en optionele peiltijd; output: vermogen en oorspronkelijke bronperiode, met uurterugval. */
export function basePvAtPeriodEnd(repository, settings, panels, at, now = at) {
  const row = repository.forecast(at - 1, at).find((item) => item.start_ms < at && item.end_ms >= at);
  if (!row) return null;
  // De grafiek bewaart de ongecorrigeerde basis van verstreken blokken. Een
  // latere terugblik mag de leerbasis niet vervangen door vernieuwde instraling.
  const pv = createPvForecastModel(repository, settings, panels, now).estimate(row);
  return { power_w: pv.base_power_w, groups: pv.groups.map(({ base_power_w, power_w, ...group }) => ({ ...group, power_w: base_power_w })),
    fetched_ms: row.fetched_ms, start: new Date(row.sample_start_ms ?? row.start_ms).toISOString(),
    end: new Date(row.sample_end_ms ?? row.end_ms).toISOString(), source_resolution_minutes: row.source_resolution_minutes ?? (row.end_ms - row.start_ms) / 60000 };
}
