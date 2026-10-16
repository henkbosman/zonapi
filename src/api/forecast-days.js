import { dayForecastResponse } from './day-forecast.js';
import { localDay } from '../weather/local-day.js';
import { addCalendarDays } from '../weather/local-calendar.js';
import { offlineSunTimes } from '../weather/solar-position.js';

/** Leest een voorspelling voor één Nederlandse kalenderdag; input: opslag, instellingen, panelen, fouten, huidige zonstatus, peiltijd en optionele datum; output: dagvoorspelling met eigen zonuren. */
export function forecastDayForDate(repository, settings, panels, panelErrors, sunlight, now, date = localDay(now)) {
  const day = addCalendarDays(date);
  const stored = repository.getSun(day);
  const current = day === localDay(now) && sunlight.sunrise && sunlight.sunset ? sunlight : null;
  const { latitude, longitude } = settings.location;
  const sun = stored ?? (!current && Number.isFinite(latitude) && Number.isFinite(longitude) ? offlineSunTimes(day, latitude, longitude) : null);
  const bounds = sun ? { sunrise: new Date(sun.sunrise_ms).toISOString(), sunset: new Date(sun.sunset_ms).toISOString() } : current ?? {};
  return { date: day, ...dayForecastResponse(repository, settings, panels, panelErrors, bounds, now) };
}

/** Leest vandaag, morgen en overmorgen uit dezelfde lokale voorspellingopslag; input: opslag, instellingen, panelen, fouten, zonstatus en peiltijd; output: drie gedateerde dagvoorspellingen. */
export function forecastDaysResponse(repository, settings, panels, panelErrors, sunlight, now) {
  const today = localDay(now);
  return { generated_at: new Date(now).toISOString(), days: [0, 1, 2].map((offset) =>
    forecastDayForDate(repository, settings, panels, panelErrors, sunlight, now, addCalendarDays(today, offset))) };
}
