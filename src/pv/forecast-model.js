import { estimatePv } from './model.js';
import { getCalibrationFactor } from './calibration.js';
import { automaticCorrectionConfig } from './automatic-config.js';
import { correctionModelKey } from './correction-key.js';
import { clockQuarter, quarterLabel, splitForecastQuarters } from './quarter.js';
import { applyPvCorrection } from './apply-correction.js';
import { localDay } from '../weather/local-day.js';
import { localDayRange } from '../weather/local-calendar.js';

const quarterMs = 900000;

/** Maakt een voorspelsnapshot met eigen kwartiercorrecties en terugval op eerdere meetdagen voor vandaag en toekomstige dagen; input: opslag, instellingen, panelen en peiltijd; output: voorbereiden, schatten en status. */
export function createPvForecastModel(repository, settings, panels, now) {
  const config = automaticCorrectionConfig(settings), modelKey = correctionModelKey(settings, panels);
  const factor = getCalibrationFactor(settings);
  const blocks = repository.pvBlockCorrections(modelKey, now - 27 * 3600000, now + (settings.weather.forecast_days + 1) * 86400000)
    .filter((row) => row.end_ms <= now && row.measured_ms <= now && row.updated_ms <= now).map((row) => ({ ...row, factor: Math.min(config.max_factor, row.factor) }));
  const byEnd = new Map(blocks.map((row) => [row.end_ms, row]));
  const byClock = new Map(repository.pvBlockCorrectionPattern(modelKey, now)
    .map((row) => [row.quarter_minute, { ...row, factor: Math.min(config.max_factor, row.factor) }]));
  const today = localDay(now);
  const previousDays = new Map(repository.pvBlockCorrectionPattern(modelKey, now, localDayRange(today).start_ms)
    .map((row) => [row.quarter_minute, { ...row, factor: Math.min(config.max_factor, row.factor) }]));
  const savedLatest = repository.latestPvBlockCorrection(modelKey, now);
  const latest = savedLatest ? { ...savedLatest, factor: Math.min(config.max_factor, savedLatest.factor) } : null;
  const active = config.enabled && latest !== null;
  const savedAttempt = repository.diagnosticState?.('growatt', 'pv_correction');
  const lastAttempt = savedAttempt?.model_key === modelKey && Date.parse(savedAttempt.attempted_at) <= now ? savedAttempt : null;
  const past = new Map();
  for (const row of repository.pv(now - 27 * 3600000, now)) {
    if (!past.has(row.group_id)) past.set(row.group_id, []);
    past.get(row.group_id).push(row);
  }

  /** Splitst de bron zodat één kwartier nooit de factor van zijn buur krijgt; input: bronvakken; output: onafhankelijke kwartierdelen. */
  function prepare(rows) { return active ? splitForecastQuarters(rows) : rows; }

  /** Gebruikt de eigen gemeten correctie of voor vandaag en later de factor van hetzelfde klokkwartier op een eerdere meetdag; input: effectief weertijdvak; output: eigen basis, gecorrigeerde groepen en correctieherkomst. */
  function estimate(row) {
    let base = estimatePv(row, panels, settings.location.latitude, settings.location.longitude, factor);
    const block = active ? byEnd.get(Math.ceil(row.end_ms / quarterMs) * quarterMs) : null;
    const own = block && row.start_ms >= block.start_ms && row.end_ms <= block.end_ms;
    if (own) {
      let snapshot;
      try { snapshot = JSON.parse(block.sampling_json)?.forecast; } catch { /* Oudere correcties bevatten alleen het totale basisvermogen. */ }
      if (Array.isArray(snapshot?.groups) && snapshot.groups.length === base.groups.length
        && snapshot.groups.every((group) => base.groups.some((item) => item.group_id === group.group_id && item.inverter_id === group.inverter_id) && Number.isFinite(group.power_w))) {
        base = { power_w: block.predicted_w, groups: snapshot.groups };
      } else if (base.power_w > 0 && base.power_w !== block.predicted_w) {
        const ratio = block.predicted_w / base.power_w;
        base = { power_w: block.predicted_w, groups: base.groups.map((group) => ({ ...group, power_w: group.power_w * ratio })) };
      }
    } else if (row.end_ms <= now) {
      const stored = base.groups.map((group) => past.get(group.group_id)?.find((item) => item.model_key === modelKey
        && Number.isFinite(item.base_power_w) && item.start_ms <= row.start_ms && item.end_ms >= row.end_ms));
      if (stored.length && stored.every(Boolean)) {
        const groups = stored.map((item, index) => ({ ...base.groups[index], power_w: item.base_power_w, gti_w_m2: item.gti_w_m2 }));
        base = { groups, power_w: Math.round(groups.reduce((sum, group) => sum + group.power_w, 0) * 10) / 10 };
      }
    }
    // Alleen de factor wordt hergebruikt: de instraling en paneelgroepen blijven van de voorspelde dag zelf.
    const date = localDay(row.start_ms), quarter = clockQuarter(Math.ceil(row.end_ms / quarterMs) * quarterMs);
    const reference = own ? block : !active ? null : date === today ? previousDays.get(quarter)
      : date > today ? byClock.get(quarter) : null;
    return { ...applyPvCorrection(base, panels, reference?.factor ?? 1),
      correction_source: own ? 'block' : reference ? 'same_clock_quarter' : 'none',
      correction_reference_start: reference ? new Date(reference.start_ms).toISOString() : null,
      correction_reference_end: reference ? new Date(reference.end_ms).toISOString() : null };
  }

  /** Beschrijft de eigen gemeten blokken en terugval voor vandaag en later; input: geen; output: status met expliciete datums en tijdvakgrenzen. */
  function status() {
    const sampling = (row) => { try { return row?.sampling_json ? JSON.parse(row.sampling_json) : null; } catch { return null; } };
    const describe = (row, start, end) => ({ date: localDay(start), start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      time: quarterLabel(clockQuarter(end)), quarter_minute: clockQuarter(end), factor: row?.factor ?? null,
      correction_percent: row ? Math.round((row.factor - 1) * 1000) / 10 : null,
      measured_at: row ? new Date(row.measured_ms).toISOString() : null, updated_at: row ? new Date(row.updated_ms).toISOString() : null,
      predicted_w: row?.predicted_w ?? null, measured_w: row?.measured_w ?? null, sampling: sampling(row) });
    const day = localDay(now), range = localDayRange(day), quarters = [];
    for (let start = range.start_ms; start < range.end_ms; start += quarterMs) quarters.push(describe(byEnd.get(start + quarterMs), start, start + quarterMs));
    const learnedToday = quarters.filter((row) => row.factor !== null).length;
    return { enabled: config.enabled, mode: config.mode, scope: 'independent_quarters',
      today_policy: 'own_block_then_previous_day_same_clock_quarter', future_day_policy: 'same_clock_quarter',
      status: !config.enabled ? 'disabled' : active ? 'active' : 'learning', model_key: modelKey,
      min_forecast_w: config.min_forecast_w, max_factor: config.max_factor, max_skew_seconds: config.max_skew_seconds,
      sample_tolerance_seconds: config.sample_tolerance_seconds, outlier_relative: config.outlier_relative, outlier_min_w: config.outlier_min_w,
      day, learned_blocks: repository.countPvBlockCorrections(modelKey, now), learned_blocks_today: learnedToday, learned_clock_quarters: byClock.size,
      learned_quarters: learnedToday, total_blocks_in_day: quarters.length, last_attempt: lastAttempt,
      latest: latest ? describe(latest, latest.start_ms, latest.end_ms) : null, quarters };
  }
  return { prepare, estimate, status, modelKey, active };
}
