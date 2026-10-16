import { estimatePv } from '../pv/model.js';
import { getCalibrationFactor } from '../pv/calibration.js';

/** Simuleert een volledig stroomprofiel tegen voorspeltijdvakken; input: apparaat, start-ms, weertijdvakken, modelcontext; output: energie/fractie of null bij een gat. */
export function evaluateStart(profile, startMs, weather, context) {
  let cursor = startMs;
  let totalWh = 0;
  let solarWh = 0;
  let recordAgeMs = 0;
  const reserve = profile.reserve_w ?? context.settings.advice.reserve_w;
  const predictions = context.predictions ?? new Map();
  const calibrationFactor = getCalibrationFactor(context.settings);
  for (const step of profile.steps) {
    const finish = cursor + step.duration_minutes * 60000;
    while (cursor < finish) {
      const row = weather.find((item) => item.start_ms <= cursor && item.end_ms > cursor);
      if (!row) return null;
      const end = Math.min(row.end_ms, finish);
      if (!predictions.has(row.start_ms)) predictions.set(row.start_ms, context.pvModel ? context.pvModel.estimate(row).power_w : estimatePv(row, context.panels, context.latitude, context.longitude, calibrationFactor).power_w);
      const available = Math.max(0, predictions.get(row.start_ms) - context.baseload.power_w - reserve);
      const hours = (end - cursor) / 3600000;
      totalWh += step.power_w * hours;
      solarWh += Math.min(step.power_w, available) * hours;
      recordAgeMs = Math.max(recordAgeMs, context.now - row.fetched_ms);
      cursor = end;
    }
  }
  return { start: new Date(startMs).toISOString(), solar_share_percent: totalWh ? Math.round(solarWh / totalWh * 1000) / 10 : 100, energy_wh: Math.round(totalWh), solar_wh: Math.round(solarWh), forecast_age_minutes: Math.max(0, Math.round(recordAgeMs / 60000)) };
}

/** Zoekt vroegste passende en beste starttijd van een machine; input: profiel, weerreeks, modelcontext; output: advies met versheid/status. */
export function advise(profile, weather, context) {
  if (context.panelErrors.length) return { status: 'configuration_incomplete', missing: context.panelErrors, can_start_now: null, earliest_start: null, best_start: null };
  if (!context.baseload) return { status: 'insufficient_baseload', can_start_now: null, earliest_start: null, best_start: null };
  if (!weather.length) return { status: 'forecast_unavailable', can_start_now: null, earliest_start: null, best_start: null };
  const threshold = profile.min_solar_share ?? context.settings.advice.min_solar_share;
  const start = context.window?.from ?? context.now;
  const end = context.window?.until ?? context.now + context.settings.advice.search_hours * 3600000;
  const nowStart = context.now >= start && context.now <= end ? evaluateStart(profile, context.now, weather, context) : null;
  const stepMs = context.settings.advice.start_step_minutes * 60000;
  let first = nowStart && nowStart.solar_share_percent / 100 >= threshold ? nowStart : null;
  let best = nowStart;
  let evaluated = 0;
  for (let at = Math.ceil(start / stepMs) * stepMs; at <= end; at += stepMs) {
    const result = evaluateStart(profile, at, weather, context);
    if (!result) continue;
    evaluated++;
    if (!first && result.solar_share_percent / 100 >= threshold) first = result;
    if (!best || result.solar_share_percent > best.solar_share_percent) best = result;
  }
  if (!evaluated && !nowStart) return { status: 'forecast_incomplete', can_start_now: null, earliest_start: null, best_start: null, search_until: new Date(end).toISOString() };
  const staleLimit = context.settings.weather.stale_after_hours * 3600000;
  const stale = [first, best, nowStart].some((item) => item && item.forecast_age_minutes * 60000 > staleLimit);
  return {
    status: stale ? 'stale' : 'ok', id: profile.id, duration_minutes: profile.duration_minutes,
    estimated_profile: profile.estimated_profile === true, baseload: context.baseload, minimum_solar_share_percent: threshold * 100,
    can_start_now: stale || !nowStart ? null : nowStart.solar_share_percent / 100 >= threshold,
    now: nowStart, earliest_start: first?.start ?? null, earliest: first, best_start: best?.start ?? null, best,
    search_until: new Date(end).toISOString(), evaluated_starts: evaluated
  };
}
