import { estimatePv } from './model.js';
import { getCalibrationFactor } from './calibration.js';

/** Herberekent lopende en toekomstige PV-cache met actuele instellingen; input: repository, instellingen, panelen, configuratiefouten en huidige ms; output: aantal opgeslagen groepswaarden. */
export function refreshPvForecast(repository, settings, panels, panelErrors, now) {
  const { latitude, longitude } = settings.location;
  if (panelErrors.length || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return 0;
  const factor = getCalibrationFactor(settings);
  const rows = repository.forecastCandidates(now, now + (settings.weather.forecast_days + 1) * 86400000);
  const db = repository.database();
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const result = estimatePv(row, panels, latitude, longitude, factor);
      for (const group of result.groups) {
        repository.savePv({ ...row, ...group });
        count++;
      }
    }
    db.exec('COMMIT');
    return count;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
