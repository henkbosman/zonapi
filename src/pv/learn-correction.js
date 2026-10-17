import { createHash } from 'node:crypto';
import { automaticCorrectionConfig } from './automatic-config.js';
import { correctionModelKey } from './correction-key.js';
import { clockQuarter, quarterLabel } from './quarter.js';
import { basePvAtTime } from './base-at-time.js';
import { refreshPvForecast } from './refresh-forecast.js';
import { productionFreshnessMinutes } from '../production/freshness.js';

/** Leert één actuele kwartiercorrectie van een volledige Growatt-meetronde; input: opslag, instellingen, panelen, configuratiefouten, meetrijen en ontvangsttijd; output: status, factor en kwartier, zonder stapeling of leren van onvolledige/te oude metingen. */
export function learnPvCorrection(repository, settings, panels, panelErrors, rows, now) {
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
  const modelKey = correctionModelKey(settings, panels), pattern = repository.pvCorrectionPattern(modelKey);
  const latest = [...pattern].sort((a, b) => b.measured_ms - a.measured_ms)[0];
  if (latest && measuredMs < latest.measured_ms) return { status: 'older_measurement' };
  const predicted = basePvAtTime(repository, settings, panels, measuredMs);
  if (!predicted) return { status: 'forecast_unavailable' };
  if (now - predicted.fetched_ms > settings.weather.stale_after_hours * 3600000) return { status: 'forecast_stale' };
  if (predicted.power_w < config.min_forecast_w) return { status: 'low_forecast' };
  const measured = values.reduce((sum, row) => sum + row.power_w, 0);
  const factor = Math.round(Math.min(config.max_factor, measured / predicted.power_w) * 1000000) / 1000000;
  const signature = createHash('sha256').update(JSON.stringify({ values: values.map(({ serial, measured_ms, power_w }) => [serial, measured_ms, power_w]).sort(),
    predicted_w: predicted.power_w, fetched_ms: predicted.fetched_ms, factor })).digest('hex');
  const quarter = clockQuarter(measuredMs);
  if (pattern.find((row) => row.quarter_minute === quarter)?.signature === signature) return { status: 'unchanged', factor, time: quarterLabel(quarter) };
  const db = repository.database();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = repository.savePvCorrection({ model_key: modelKey, quarter_minute: quarter, factor, predicted_w: predicted.power_w,
      measured_w: measured, measured_ms: measuredMs, updated_ms: now, signature });
    if (result.changes) refreshPvForecast(repository, settings, panels, panelErrors, now, { transaction: false });
    db.exec('COMMIT');
    return { status: result.changes ? 'updated' : 'unchanged', factor, time: quarterLabel(quarter), correction_percent: Math.round((factor - 1) * 1000) / 10 };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
