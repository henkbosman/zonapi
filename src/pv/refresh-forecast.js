import { createPvForecastModel } from './forecast-model.js';
import { clockQuarter } from './quarter.js';
import { localDay } from '../weather/local-day.js';

/** Herberekent de cache vanaf vandaag of het geleerde blok plus hetzelfde klokkwartier op latere kalenderdagen; input: model, opslag, peiltijd en optionele transactie/blokeindtijd; output: aantal opgeslagen groepswaarden. */
export function refreshPvForecast(repository, settings, panels, panelErrors, now, { transaction = true, blockEndMs = null } = {}) {
  const { latitude, longitude } = settings.location;
  if (panelErrors.length || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return 0;
  const model = createPvForecastModel(repository, settings, panels, now);
  const from = blockEndMs === null ? now - 27 * 3600000 : blockEndMs - 900000;
  const until = now + (settings.weather.forecast_days + 1) * 86400000;
  const rows = repository.forecast(from, until);
  const learnedEnds = new Set(repository.pvBlockCorrections(model.modelKey, from, now).map((row) => row.end_ms));
  const db = repository.database();
  const today = localDay(now), learnedQuarter = blockEndMs === null ? null : clockQuarter(blockEndMs);
  const learnedDay = blockEndMs === null ? null : localDay(from);
  let count = 0;
  if (transaction) db.exec('BEGIN');
  try {
    for (const row of model.prepare(rows)) {
      if (blockEndMs !== null) {
        const own = row.start_ms >= from && row.end_ms <= blockEndMs;
        const date = localDay(row.start_ms);
        const matchingForecast = date >= today && date > learnedDay && clockQuarter(Math.ceil(row.end_ms / 900000) * 900000) === learnedQuarter;
        if (!own && !matchingForecast) continue;
      }
      const pastWithoutMeasurement = blockEndMs === null && row.end_ms <= now && !learnedEnds.has(row.end_ms);
      if (pastWithoutMeasurement && localDay(row.start_ms) < today) continue;
      const result = model.estimate(row);
      if (pastWithoutMeasurement && result.correction_source !== 'same_clock_quarter') continue;
      for (const group of result.groups) {
        repository.savePv({ ...row, ...group, correction_factor: result.correction_factor, computed_ms: now, model_key: model.modelKey });
        count++;
      }
    }
    if (transaction) db.exec('COMMIT');
    return count;
  } catch (error) { if (transaction) db.exec('ROLLBACK'); throw error; }
}
