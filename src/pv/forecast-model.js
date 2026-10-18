import { estimatePv } from './model.js';
import { getCalibrationFactor } from './calibration.js';
import { automaticCorrectionConfig } from './automatic-config.js';
import { correctionModelKey } from './correction-key.js';
import { clockQuarter, quarterLabel, splitForecastQuarters } from './quarter.js';
import { applyPvCorrection } from './apply-correction.js';
import { localDay } from '../weather/local-day.js';

/** Maakt één consistente voorspelsnapshot met livecorrectie, kwartierpatroon en bevroren verleden; input: opslag, instellingen, panelen en peiltijd; output: {prepare,estimate,status,modelKey}. */
export function createPvForecastModel(repository, settings, panels, now) {
  const config = automaticCorrectionConfig(settings), modelKey = correctionModelKey(settings, panels);
  const factor = getCalibrationFactor(settings);
  const pattern = repository.pvCorrectionPattern(modelKey).filter((row) => row.measured_ms <= now).map((row) => ({ ...row, factor: Math.min(config.max_factor, row.factor) }));
  const byQuarter = new Map(pattern.map((row) => [row.quarter_minute, row]));
  const latest = [...pattern].sort((a, b) => b.measured_ms - a.measured_ms || b.updated_ms - a.updated_ms)[0] ?? null;
  const active = config.enabled && latest !== null;
  const past = new Map();
  for (const row of repository.pv(now - 27 * 3600000, now)) {
    if (!past.has(row.group_id)) past.set(row.group_id, []);
    past.get(row.group_id).push(row);
  }

  /** Bepaalt de factor voor één toekomstig kwartier; input: tijd in ms; output: factor en herkomst live/pattern/latest/none. */
  function correction(at) {
    if (!active) return { factor: 1, source: 'none' };
    if (config.mode === 'live_today_pattern' && localDay(at) === localDay(now) && localDay(latest.measured_ms) === localDay(now)) return { factor: latest.factor, source: 'live' };
    const learned = byQuarter.get(clockQuarter(at));
    return learned ? { factor: learned.factor, source: 'pattern' } : { factor: latest.factor, source: 'latest' };
  }

  /** Bereidt tijdvakken voor klokkwartiercorrecties voor; input: weerrijen; output: kwartierdelen zodra een leerpatroon bestaat, anders de oorspronkelijke reeks. */
  function prepare(rows) { return active ? splitForecastQuarters(rows) : rows; }

  /** Rekent één weertijdvak consistent om naar basis en gecorrigeerde AC-opbrengst; input: weerrij; output: groepswaarden, factor en herkomst. */
  function estimate(row) {
    const base = estimatePv(row, panels, settings.location.latitude, settings.location.longitude, factor);
    if (row.end_ms <= now) {
      const stored = base.groups.map((group) => past.get(group.group_id)?.find((item) => item.start_ms <= row.start_ms && item.end_ms >= row.end_ms));
      if (stored.length && stored.every(Boolean)) {
        const groups = stored.map((item, index) => ({ ...base.groups[index], power_w: item.power_w, base_power_w: item.base_power_w ?? item.power_w }));
        return { power_w: Math.round(groups.reduce((sum, group) => sum + group.power_w, 0) * 10) / 10,
          base_power_w: Math.round(groups.reduce((sum, group) => sum + group.base_power_w, 0) * 10) / 10,
          correction_factor: stored[0].correction_factor, correction_source: 'stored', groups };
      }
      return { ...applyPvCorrection(base, panels, 1), correction_source: 'none' };
    }
    const selected = correction((row.start_ms + row.end_ms) / 2);
    return { ...applyPvCorrection(base, panels, selected.factor), correction_source: selected.source };
  }

  /** Beschrijft de gebruikte correctiesnapshot zonder meetwaarden te wijzigen; input: geen; output: configuratie, laatste correctie en kwartierpatroon. */
  function status() {
    const sampling = (row) => { try { return row?.sampling_json ? JSON.parse(row.sampling_json) : null; } catch { return null; } };
    return { enabled: config.enabled, mode: config.mode, status: !config.enabled ? 'disabled' : active ? 'active' : 'learning', model_key: modelKey,
      min_forecast_w: config.min_forecast_w, max_factor: config.max_factor, max_skew_seconds: config.max_skew_seconds,
      sample_tolerance_seconds: config.sample_tolerance_seconds, outlier_relative: config.outlier_relative, outlier_min_w: config.outlier_min_w,
      learned_quarters: pattern.length,
      latest: latest ? { time: quarterLabel(latest.quarter_minute), factor: latest.factor, correction_percent: Math.round((latest.factor - 1) * 1000) / 10,
        measured_at: new Date(latest.measured_ms).toISOString(), updated_at: new Date(latest.updated_ms).toISOString(), predicted_w: latest.predicted_w, measured_w: latest.measured_w, sampling: sampling(latest) } : null,
      quarters: Array.from({ length: 96 }, (_, index) => {
        const minute = index * 15, row = byQuarter.get(minute);
        return { time: quarterLabel(minute), quarter_minute: minute, factor: row?.factor ?? null,
          correction_percent: row ? Math.round((row.factor - 1) * 1000) / 10 : null,
          measured_at: row ? new Date(row.measured_ms).toISOString() : null, updated_at: row ? new Date(row.updated_ms).toISOString() : null,
          predicted_w: row?.predicted_w ?? null, measured_w: row?.measured_w ?? null, sampling: sampling(row) };
      }) };
  }
  return { prepare, estimate, status, modelKey, active };
}
