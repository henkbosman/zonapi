import { createHash } from 'node:crypto';
import { automaticCorrectionConfig } from './automatic-config.js';
import { correctionModelKey } from './correction-key.js';
import { clockQuarter, quarterLabel } from './quarter.js';
import { basePvAtPeriodEnd } from './base-at-time.js';
import { refreshPvForecast } from './refresh-forecast.js';
import { productionFreshnessMinutes } from '../production/freshness.js';

/** Bewaart één gevalideerde correctie; input: opslag, model, voorbereide omvormerwaarden, ontvangsttijd en optionele kwartier-/venstermetadata; output: status/factor zonder stapeling. De dienst bereidt de drie meetmomenten voor via learnQuarterCorrection. */
export function learnPvCorrection(repository, settings, panels, panelErrors, rows, now, options = {}) {
  const config = automaticCorrectionConfig(settings);
  if (!config.enabled) return { status: 'disabled' };
  if (panelErrors.length || !Number.isFinite(settings.location.latitude) || !Number.isFinite(settings.location.longitude)) return { status: 'configuration_incomplete' };
  const serials = panels.inverters.map((item) => item.serial).filter(Boolean);
  const selected = new Map(rows.filter((row) => !serials.length || serials.includes(row.serial)).map((row) => [row.serial, row]));
  if (selected.size !== settings.growatt.expected_inverters) return { status: 'incomplete' };
  const values = [...selected.values()];
  if (values.some((row) => !Number.isFinite(row.power_w) || row.power_w < 0 || !Number.isFinite(row.measured_ms) || now < row.measured_ms || now - row.measured_ms > productionFreshnessMinutes(settings.growatt.fresh_minutes, row.source) * 60000)) return { status: 'stale' };
  const times = values.map((row) => row.measured_ms);
  if (Math.max(...times) - Math.min(...times) > config.max_skew_seconds * 1000) return { status: 'time_skew' };
  const measuredMs = Math.round(times.reduce((sum, value) => sum + value, 0) / times.length);
  const modelKey = correctionModelKey(settings, panels);
  const target = options.target_ms ?? Math.floor(measuredMs / 900000) * 900000;
  if (!Number.isSafeInteger(target) || target % 900000 !== 0 || target > now) return { status: 'invalid_block' };
  const existing = repository.pvBlockCorrection(modelKey, target);
  if (existing && measuredMs < existing.measured_ms) return { status: 'older_measurement' };
  const predicted = basePvAtPeriodEnd(repository, settings, panels, target);
  if (!predicted) return { status: 'forecast_unavailable' };
  if (now - predicted.fetched_ms > settings.weather.stale_after_hours * 3600000) return { status: 'forecast_stale' };
  if (predicted.power_w < config.min_forecast_w) return { status: 'low_forecast' };
  const measured = values.reduce((sum, row) => sum + row.power_w, 0);
  const factor = Math.round(Math.min(config.max_factor, measured / predicted.power_w) * 1000000) / 1000000;
  const signature = createHash('sha256').update(JSON.stringify({ values: values.map(({ serial, measured_ms, power_w }) => [serial, measured_ms, power_w]).sort(),
    predicted_w: predicted.power_w, fetched_ms: predicted.fetched_ms, factor,
    target_ms: target, ...(options.sampling ? { sampling: options.sampling } : {}) })).digest('hex');
  const quarter = clockQuarter(target);
  const bounds = { block_start: new Date(target - 900000).toISOString(), block_end: new Date(target).toISOString() };
  if (existing?.signature === signature) return { status: 'unchanged', factor, time: quarterLabel(quarter), ...bounds };
  const db = repository.database();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = repository.savePvBlockCorrection({ model_key: modelKey, start_ms: target - 900000, end_ms: target, factor, predicted_w: predicted.power_w,
      measured_w: measured, measured_ms: measuredMs, updated_ms: now, signature,
      sampling_json: JSON.stringify({ ...(options.sampling ?? { method: 'direct', target_time: new Date(target).toISOString() }),
        forecast: { start: predicted.start, end: predicted.end, source_resolution_minutes: predicted.source_resolution_minutes,
          power_w: predicted.power_w, groups: predicted.groups } }) });
    if (result.changes) refreshPvForecast(repository, settings, panels, panelErrors, now, { transaction: false, blockEndMs: target });
    db.exec('COMMIT');
    return { status: result.changes ? 'updated' : 'unchanged', factor, time: quarterLabel(quarter), ...bounds, correction_percent: Math.round((factor - 1) * 1000) / 10 };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
