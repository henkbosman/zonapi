/** Leest het vaste weerinterval; input: instellingen; output: geheel aantal minuten (0 pauzeert), standaard 120, of fout. */
export function getWeatherPollMinutes(settings) {
  const minutes = settings.weather?.poll_minutes === undefined ? 120 : settings.weather.poll_minutes;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error('weather.poll_minutes moet een geheel getal van 0..1440 zijn');
  return minutes;
}
