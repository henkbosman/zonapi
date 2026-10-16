import { localDay } from '../weather/local-day.js';

/** Combineert beschikbare omvormermetingen voor één kalenderdag; input: historie, nu, zontijden, verwachte aantal, versheid in minuten en serienummers; output: {points} met aantal per meetpunt. */
export function productionSeries(rows, now, sunrise, sunset, expected, freshnessMinutes, serials = []) {
  const day = localDay(now);
  const start = sunrise ? Date.parse(sunrise) : -Infinity;
  const end = sunset ? Date.parse(sunset) : Infinity;
  const allowed = new Set(serials.filter(Boolean));
  const current = new Map();
  const points = [];
  for (const row of rows) {
    const at = row.measured_ms;
    if (!Number.isFinite(at) || at > now || at < start || at > end || localDay(at) !== day) continue;
    if (allowed.size && !allowed.has(row.serial)) continue;
    if (!Number.isFinite(row.power_w) || row.power_w < 0) continue;
    current.set(row.serial, { power_w: row.power_w, at, source: row.source ?? 'shinelink' });
    const fresh = [...current.values()].filter((item) => at - item.at <= freshnessMinutes * 60000);
    const sources = [...new Set(fresh.map((item) => item.source))];
    const point = { time: new Date(at).toISOString(), power_w: Math.round(fresh.reduce((sum, item) => sum + item.power_w, 0) * 10) / 10, active_inverters: fresh.length, expected_inverters: expected, source: sources.length > 1 ? 'mixed' : sources[0] ?? null };
    if (points.at(-1)?.time === point.time) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}
