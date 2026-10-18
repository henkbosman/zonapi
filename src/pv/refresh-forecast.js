import { createPvForecastModel } from './forecast-model.js';

/** Herberekent de recente/toekomstige cache of alleen het net geleerde blok; input: model, opslag, peiltijd en optionele transactie/blokeindtijd; output: aantal opgeslagen groepswaarden. */
export function refreshPvForecast(repository, settings, panels, panelErrors, now, { transaction = true, blockEndMs = null } = {}) {
  const { latitude, longitude } = settings.location;
  if (panelErrors.length || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return 0;
  const model = createPvForecastModel(repository, settings, panels, now);
  const from = blockEndMs === null ? now - 27 * 3600000 : blockEndMs - 900000;
  const until = blockEndMs === null ? now + (settings.weather.forecast_days + 1) * 86400000 : blockEndMs;
  const rows = repository.forecast(from, until);
  const learnedEnds = new Set(repository.pvBlockCorrections(model.modelKey, from, now).map((row) => row.end_ms));
  const db = repository.database();
  let count = 0;
  if (transaction) db.exec('BEGIN');
  try {
    for (const row of model.prepare(rows)) {
      if (blockEndMs !== null && (row.start_ms < from || row.end_ms > until)) continue;
      if (blockEndMs === null && row.end_ms <= now && !learnedEnds.has(row.end_ms)) continue;
      const result = model.estimate(row);
      for (const group of result.groups) {
        repository.savePv({ ...row, ...group, correction_factor: result.correction_factor, computed_ms: now, model_key: model.modelKey });
        count++;
      }
    }
    if (transaction) db.exec('COMMIT');
    return count;
  } catch (error) { if (transaction) db.exec('ROLLBACK'); throw error; }
}
