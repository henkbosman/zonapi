import { forecastResponse } from './forecast.js';
import { getCalibrationFactor } from '../pv/calibration.js';
import { createPvForecastModel } from '../pv/forecast-model.js';
import { weatherLocationKey } from '../weather/clear-sky.js';
import { skyAppearance } from '../weather/sky-appearance.js';

/** Leest de opgeslagen dagvoorspelling met buurpunten voor de daggrenzen; input: repository, instellingen, panelen, fouten, zontijden en huidige ms; output: voorspelslots en daggrenzen. */
export function dayForecastResponse(repository, settings, panels, panelErrors, sunlight, now) {
  const start = Date.parse(sunlight.sunrise), end = Date.parse(sunlight.sunset);
  const valid = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const rows = valid ? repository.forecast(start - 3600000, end + 3600000) : [];
  const result = forecastResponse(rows, panels, panelErrors, settings.location, now, settings.weather.stale_after_hours, getCalibrationFactor(settings), createPvForecastModel(repository, settings, panels, now));
  const locationValid = Number.isFinite(settings.location.latitude) && Number.isFinite(settings.location.longitude);
  const conditions = valid && locationValid ? repository.weatherConditions(weatherLocationKey(settings.location), Math.floor(start / 3600000) * 3600000, Math.ceil(end / 3600000) * 3600000)
    .filter((row) => row.fetched_ms <= now) : [];
  return { ...result, status: valid ? result.status : 'sun_times_unavailable',
    conditions: { resolution_minutes: 60, time_basis: 'instant', rows: conditions.map((row) => ({ time: new Date(row.time_ms).toISOString(),
      cloud_cover_percent: row.cloud_cover, weather_code: row.weather_code, condition: skyAppearance(row.cloud_cover),
      weather_model: ['best_match', 'icon_d2'].includes(row.model) ? row.model : 'unknown', fetched_at: new Date(row.fetched_ms).toISOString(),
      stale: now - row.fetched_ms > settings.weather.stale_after_hours * 3600000 })) },
    sunrise: valid ? sunlight.sunrise : null, sunset: valid ? sunlight.sunset : null, now: new Date(now).toISOString() };
}
