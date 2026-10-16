import { createPvForecastModel } from './forecast-model.js';

/** Herberekent lopende en toekomstige PV-cache met actuele correcties; input: repository, instellingen, panelen, fouten, huidige ms en optionele transactievlag; output: aantal opgeslagen groepswaarden, verstreken tijdvakken blijven behouden. */
export function refreshPvForecast(repository, settings, panels, panelErrors, now, { transaction = true } = {}) {
  const { latitude, longitude } = settings.location;
  if (panelErrors.length || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return 0;
  const model = createPvForecastModel(repository, settings, panels, now);
  const until = now + (settings.weather.forecast_days + 1) * 86400000;
  const rows = model.active ? repository.forecast(now, until) : repository.forecastCandidates(now, until);
  const db = repository.database();
  let count = 0;
  if (transaction) db.exec('BEGIN');
  try {
    for (const row of model.prepare(rows)) {
      if (row.end_ms <= now) continue;
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
