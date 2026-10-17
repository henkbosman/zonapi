import { localDay } from '../weather/local-day.js';
import { offlineSunTimes } from '../weather/solar-position.js';
import { advise } from './start-advice.js';
import { coversForecastWindow } from './forecast-coverage.js';
import { createActiveDemand } from './active-demand.js';

/** Zoekt voor iedere voorspelde kalenderdag een starttijd per apparaat; input: profielen, weerrijen, modelcontext en repository; output: dagen met cyclusadviezen. */
export function dailyAdvice(profiles, weather, context, repository) {
  const today = localDay(context.now);
  const predictions = new Map();
  const activeDemand = context.activeDemand ?? createActiveDemand(profiles, repository, context.settings, context.now);
  const days = [];
  for (let index = 0; index < context.settings.weather.forecast_days; index++) {
    const day = new Date(Date.parse(`${today}T12:00:00Z`) + index * 86400000).toISOString().slice(0, 10);
    const locationOk = Number.isFinite(context.latitude) && Number.isFinite(context.longitude);
    const sun = repository.getSun(day) ?? (locationOk ? offlineSunTimes(day, context.latitude, context.longitude) : null);
    const appliances = profiles.map((profile) => {
      const from = sun ? Math.max(context.now, sun.sunrise_ms) : null;
      const until = sun ? sun.sunset_ms - profile.duration_minutes * 60000 : null;
      const advice = !sun ? { status: 'sun_times_unavailable', earliest_start: null }
        : until < from ? { status: 'no_daylight_window', earliest_start: null }
          : advise(profile, weather, { ...context, activeDemand, predictions, window: { from, until } });
      if (advice.status === 'ok' && !coversForecastWindow(weather, from, sun.sunset_ms)) {
        advice.status = 'forecast_incomplete';
        advice.can_start_now = null;
        advice.earliest_start = null;
        advice.earliest = null;
      }
      return { id: profile.id, name: profile.name, duration_minutes: profile.duration_minutes, ...advice };
    });
    days.push({ date: day, sunrise: sun ? new Date(sun.sunrise_ms).toISOString() : null,
      sunset: sun ? new Date(sun.sunset_ms).toISOString() : null, appliances });
  }
  return { generated_at: new Date(context.now).toISOString(), active_appliances: activeDemand.metadata, days };
}
