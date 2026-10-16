import { forecastResponse } from './forecast.js';
import { getCalibrationFactor } from '../pv/calibration.js';
import { createPvForecastModel } from '../pv/forecast-model.js';

/** Leest de opgeslagen dagvoorspelling met buurpunten voor de daggrenzen; input: repository, instellingen, panelen, fouten, zontijden en huidige ms; output: voorspelslots en daggrenzen. */
export function dayForecastResponse(repository, settings, panels, panelErrors, sunlight, now) {
  const start = Date.parse(sunlight.sunrise), end = Date.parse(sunlight.sunset);
  const valid = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const rows = valid ? repository.forecast(start - 3600000, end + 3600000) : [];
  const result = forecastResponse(rows, panels, panelErrors, settings.location, now, settings.weather.stale_after_hours, getCalibrationFactor(settings), createPvForecastModel(repository, settings, panels, now));
  return { ...result, status: valid ? result.status : 'sun_times_unavailable',
    sunrise: valid ? sunlight.sunrise : null, sunset: valid ? sunlight.sunset : null, now: new Date(now).toISOString() };
}
