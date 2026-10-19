import { estimatePv } from '../pv/model.js';
import { getCalibrationFactor } from '../pv/calibration.js';

const SHARE_EPSILON = 1e-12;

/** Simuleert een volledig stroomprofiel tegen voorspeltijdvakken; input: apparaat, start-ms, weertijdvakken, modelcontext; output: energie/fractie of null bij een gat. */
export function evaluateStart(profile, startMs, weather, context) {
  const busyUntil = context.activeDemand?.busyUntil(profile.id);
  if (busyUntil !== null && busyUntil !== undefined && startMs < busyUntil) return null;
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
      const available = predictions.get(row.start_ms) - context.baseload.power_w - reserve;
      const hours = (end - cursor) / 3600000;
      totalWh += step.power_w * hours;
      solarWh += context.activeDemand ? context.activeDemand.solarWh(cursor, end, available, step.power_w) : Math.min(step.power_w, Math.max(0, available)) * hours;
      recordAgeMs = Math.max(recordAgeMs, context.now - row.fetched_ms);
      cursor = end;
    }
  }
  const fraction = totalWh ? Math.min(1, Math.max(0, solarWh / totalWh)) : 1;
  const share = fraction >= 1 - SHARE_EPSILON ? 1 : fraction;
  // Rond uitsluitend de weergave af: een gedeeltelijk gedekte cyclus mag daardoor geen 100%-advies worden.
  const percent = Math.min(share < 1 ? 99.9 : 100, Math.round(share * 1000) / 10);
  return { start: new Date(startMs).toISOString(), solar_share: share, solar_share_percent: percent,
    ...(profile.program_id ? { program_id: profile.program_id, program_name: profile.program_name, duration_minutes: profile.duration_minutes } : {}),
    energy_wh: Math.round(totalWh), solar_wh: Math.round(solarWh), forecast_age_minutes: Math.max(0, Math.round(recordAgeMs / 60000)) };
}

/** Zoekt vroegste passende en beste starttijd van een machine; input: profiel, weerreeks, modelcontext; output: advies met versheid/status. */
export function advise(profile, weather, context) {
  const busyUntil = context.activeDemand?.busyUntil(profile.id) ?? null;
  const active = context.activeDemand ? { active_appliances: context.activeDemand.metadata.filter((item) => item.id !== profile.id),
    ...(busyUntil !== null && busyUntil > context.now ? { already_active: true, busy_until: new Date(busyUntil).toISOString() } : {}) } : {};
  if (context.panelErrors.length) return { ...active, status: 'configuration_incomplete', missing: context.panelErrors, can_start_now: null, earliest_start: null, best_start: null };
  if (!context.baseload) return { ...active, status: 'insufficient_baseload', can_start_now: null, earliest_start: null, best_start: null };
  if (!weather.length) return { ...active, status: 'forecast_unavailable', can_start_now: null, earliest_start: null, best_start: null };
  const threshold = profile.min_solar_share ?? context.settings.advice.min_solar_share;
  const start = Math.max(context.window?.from ?? context.now, busyUntil ?? -Infinity);
  const end = context.window?.until ?? context.now + context.settings.advice.search_hours * 3600000;
  if (start > end && busyUntil !== null) return { ...active, status: 'already_active', can_start_now: false, earliest_start: null, best_start: null, search_until: new Date(end).toISOString() };
  const nowStart = context.now >= start && context.now <= end ? evaluateStart(profile, context.now, weather, context) : null;
  const stepMs = context.settings.advice.start_step_minutes * 60000;
  let first = nowStart && nowStart.solar_share >= threshold - SHARE_EPSILON ? nowStart : null;
  let best = nowStart;
  let evaluated = 0;
  for (let at = Math.ceil(start / stepMs) * stepMs; at <= end; at += stepMs) {
    const result = evaluateStart(profile, at, weather, context);
    if (!result) continue;
    evaluated++;
    if (!first && result.solar_share >= threshold - SHARE_EPSILON) first = result;
    if (!best || result.solar_share > best.solar_share + SHARE_EPSILON) best = result;
  }
  if (!evaluated && !nowStart) return { ...active, status: 'forecast_incomplete', can_start_now: null, earliest_start: null, best_start: null, search_until: new Date(end).toISOString() };
  const staleLimit = context.settings.weather.stale_after_hours * 3600000;
  const stale = [first, best, nowStart].some((item) => item && item.forecast_age_minutes * 60000 > staleLimit);
  return {
    ...active, status: stale ? 'stale' : 'ok', id: profile.id, duration_minutes: profile.duration_minutes,
    ...(profile.program_id ? { program_id: profile.program_id, program_name: profile.program_name } : {}),
    estimated_profile: profile.estimated_profile === true, baseload: context.baseload, minimum_solar_share_percent: threshold * 100,
    can_start_now: busyUntil !== null && context.now < busyUntil ? false : stale || !nowStart ? null : nowStart.solar_share >= threshold - SHARE_EPSILON,
    now: nowStart, earliest_start: first?.start ?? null, earliest: first, best_start: best?.start ?? null, best,
    search_until: new Date(end).toISOString(), evaluated_starts: evaluated
  };
}
