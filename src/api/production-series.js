import { localDay } from '../weather/local-day.js';

/** Bundelt complete omvormerrondes tot één dagtotaal per meetmoment; input: historie, nu, zonuren, omvormeraantal, versheid, serienummers en optionele groepeertijd in seconden; output: chronologische totaalpunten zonder individuele tussenstanden. */
export function productionSeries(rows, now, sunrise, sunset, expected, freshnessMinutes, serials = [], groupSeconds = 60) {
  const day = localDay(now);
  const start = sunrise ? Date.parse(sunrise) : -Infinity;
  const end = sunset ? Date.parse(sunset) : Infinity;
  const allowed = new Set(serials.filter(Boolean));
  const current = new Map();
  const points = [];
  const pending = new Set();
  let roundStart = null, lastAt = null;

  /** Bewaart één complete ronde en begint daarna een nieuwe; input: geen (gebruikt de actuele omvormers); output: void, onvolledige totalen worden niet getekend. */
  function finishRound() {
    if (!pending.size) return;
    const fresh = [...current.values()].filter((item) => lastAt - item.at <= freshnessMinutes * 60000);
    if (fresh.length === expected) {
      const sources = [...new Set(fresh.map((item) => item.source))];
      const point = { time: new Date(lastAt).toISOString(), power_w: Math.round(fresh.reduce((sum, item) => sum + item.power_w, 0) * 10) / 10,
        active_inverters: fresh.length, expected_inverters: expected, source: sources.length > 1 ? 'mixed' : sources[0] ?? null };
      if (points.at(-1)?.time === point.time) points[points.length - 1] = point;
      else points.push(point);
    }
    pending.clear();
    roundStart = null;
  }

  for (const row of [...rows].sort((a, b) => a.measured_ms - b.measured_ms)) {
    const at = row.measured_ms;
    if (!Number.isFinite(at) || at > now || at < start || at > end || localDay(at) !== day) continue;
    if (allowed.size && !allowed.has(row.serial)) continue;
    if (!Number.isFinite(row.power_w) || row.power_w < 0) continue;
    if (pending.size && at - roundStart >= groupSeconds * 1000) finishRound();
    if (!pending.size) roundStart = at;
    current.set(row.serial, { power_w: row.power_w, at, source: row.source ?? 'shinelink' });
    pending.add(row.serial);
    lastAt = at;
    if (pending.size === expected) finishRound();
  }
  finishRound();
  return points;
}
