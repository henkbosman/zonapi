import { createHash } from 'node:crypto';
import { automaticCorrectionConfig } from './automatic-config.js';
import { correctionModelKey } from './correction-key.js';
import { clockQuarter, quarterLabel } from './quarter.js';
import { basePvAtPeriodEnd } from './base-at-time.js';
import { refreshPvForecast } from './refresh-forecast.js';
import { productionFreshnessMinutes } from '../production/freshness.js';
import { localDay } from '../weather/local-day.js';
import { localDayRange } from '../weather/local-calendar.js';

/** Valideert een meetblok en bewaart standaard uitsluitend de invoer tot de hemelcontrole; input: opslag, model, omvormerwaarden, ontvangsttijd en venstermetadata; output: wachtstatus. De afzonderlijke rekenlaag kan direct worden getoetst met defer:false. */
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
  const predicted = basePvAtPeriodEnd(repository, settings, panels, target, now);
  if (!predicted) return { status: 'forecast_unavailable' };
  if (now - predicted.fetched_ms > settings.weather.stale_after_hours * 3600000) return { status: 'forecast_stale' };
  if (predicted.power_w < config.min_forecast_w) return { status: 'low_forecast' };
  const measured = values.reduce((sum, row) => sum + row.power_w, 0);
  const signature = createHash('sha256').update(JSON.stringify({ values: values.map(({ serial, measured_ms, power_w }) => [serial, measured_ms, power_w]).sort(),
    predicted_w: predicted.power_w, fetched_ms: predicted.fetched_ms, max_factor: config.max_factor,
    target_ms: target, ...(options.sampling ? { sampling: options.sampling } : {}) })).digest('hex');
  const quarter = clockQuarter(target);
  const bounds = { block_start: new Date(target - 900000).toISOString(), block_end: new Date(target).toISOString() };
  if (existing?.signature === signature) return { status: 'unchanged', factor: existing.factor, time: quarterLabel(quarter), ...bounds };
  const row = { model_key: modelKey, start_ms: target - 900000, end_ms: target, predicted_w: predicted.power_w,
    measured_w: measured, measured_ms: measuredMs, updated_ms: now, signature,
    sampling_json: JSON.stringify({ ...(options.sampling ?? { method: 'direct', target_time: new Date(target).toISOString() }),
      forecast: { start: predicted.start, end: predicted.end, source_resolution_minutes: predicted.source_resolution_minutes,
        power_w: predicted.power_w, groups: predicted.groups } }) };
  if (options.defer !== false) {
    const ready = localDayRange(localDay(row.start_ms)).end_ms;
    repository.savePvCorrectionCandidate(row, now, ready);
    return { status: now < ready ? 'waiting_for_day_end' : 'checking_clear_sky', ready_at: new Date(ready).toISOString(), time: quarterLabel(quarter), ...bounds };
  }
  return publishPvCorrection(repository, settings, panels, panelErrors, row, now);
}

/** Publiceert een reeds bij ontvangst gevalideerd blok; input: opslag, model, voorbereide rij, peiltijd en optionele heldere-hemelonderbouwing; output: opgeslagen correctie en één atomaire cacheverversing. */
export function publishPvCorrection(repository, settings, panels, panelErrors, row, now, clearSky = null) {
  if (row.model_key !== correctionModelKey(settings, panels) || row.measured_ms > now || row.end_ms > now
    || !Number.isFinite(row.predicted_w) || row.predicted_w <= 0 || !Number.isFinite(row.measured_w) || row.measured_w < 0
    || row.start_ms !== row.end_ms - 900000 || row.end_ms % 900000 !== 0) throw new Error('Ongeldige voorbereide kwartiercorrectie');
  const factor = Math.round(Math.min(automaticCorrectionConfig(settings).max_factor, row.measured_w / row.predicted_w) * 1000000) / 1000000;
  const sampling = JSON.parse(row.sampling_json);
  const db = repository.database();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = repository.savePvBlockCorrection({ ...row, factor, updated_ms: now,
      sampling_json: JSON.stringify({ ...sampling, ...(clearSky ? { clear_sky: clearSky } : {}) }) });
    if (result.changes) refreshPvForecast(repository, settings, panels, panelErrors, now, { transaction: false, blockEndMs: row.end_ms });
    repository.deletePvCorrectionCandidate(row.model_key, row.end_ms, row.signature);
    db.exec('COMMIT');
    return { status: result.changes ? 'updated' : 'unchanged', factor, time: quarterLabel(clockQuarter(row.end_ms)),
      block_start: new Date(row.start_ms).toISOString(), block_end: new Date(row.end_ms).toISOString(),
      target_time: new Date(row.end_ms).toISOString(), correction_percent: Math.round((factor - 1) * 1000) / 10,
      ...(clearSky ? { sampling: { ...sampling, clear_sky: clearSky }, clear_sky: clearSky } : {}) };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
