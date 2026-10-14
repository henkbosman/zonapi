import { localDay } from './local-day.js';
import { offlineSunTimes } from './solar-position.js';
import { getIrradianceSource } from './irradiance-source.js';
import { estimatePv } from '../pv/model.js';

/** Maakt een daglichtgestuurde weerscheduler; input: instellingen, panelen, fouten, repository, optionele klok/bron; output: {tick,status,start,stop}. */
export function createWeatherScheduler({ settings, panels, panelErrors, repository, clock = () => Date.now(), source = getIrradianceSource(settings.weather.source) }) {
  let interval = null;
  let inFlight = false;
  let lastError = null;
  let nextAt = null;
  const latitude = settings.location?.latitude;
  const longitude = settings.location?.longitude;
  const locationOk = Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;

  /** Geeft zontijden uit cache of offline berekening; input: lokale dag; output: grenzen of null. */
  function times(day) {
    return repository.getSun(day) ?? (locationOk ? offlineSunTimes(day, latitude, longitude) : null);
  }

  /** Leest de zonsopkomst van morgen zonder internet; input: lokale dag; output: epoch-ms of null. */
  function tomorrowSunrise(day) {
    const tomorrow = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return times(tomorrow)?.sunrise_ms ?? null;
  }

  /** Plant ophaalpoging wanneer daglicht en quotum het toestaan; input: geen; output: Promise<void>. */
  async function tick() {
    const now = clock();
    const day = localDay(now);
    const sun = times(day);
    nextAt = sun?.sunrise_ms ?? null;
    if (!locationOk || !sun || !settings.weather.max_requests_per_local_day || inFlight) { if (!settings.weather.max_requests_per_local_day) nextAt = null; return; }
    if (now < sun.sunrise_ms) return;
    if (now >= sun.sunset_ms) { nextAt = tomorrowSunrise(day); return; }
    const max = settings.weather.max_requests_per_local_day;
    const used = repository.countCalls(day);
    if (used >= max) { nextAt = tomorrowSunrise(day); return; }
    const last = repository.lastCall();
    const spacing = Math.max(3600000, (sun.sunset_ms - sun.sunrise_ms) / Math.max(1, max - 1));
    const minimum = last?.local_date === day && last.status === 'error' ? Math.max(spacing, settings.weather.retry_minutes * 60000) : spacing;
    nextAt = last?.local_date === day ? last.attempted_ms + minimum : sun.sunrise_ms;
    if (now < nextAt) return;
    inFlight = true;
    const id = repository.beginCall(day, now);
    try {
      const result = await source({ latitude, longitude, days: settings.weather.forecast_days });
      const db = repository.database();
      db.exec('BEGIN');
      try {
        for (const item of result.sun) repository.saveSun(item.day, item.sunrise_ms, item.sunset_ms, settings.weather.source, now);
        for (const row of result.rows) {
          repository.saveForecast(row);
          if (!panelErrors.length) {
            const pv = estimatePv(row, panels, latitude, longitude);
            for (const group of pv.groups) repository.savePv({ ...row, ...group, source: row.source });
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      repository.finishCall(id, 'ok');
      lastError = null;
    } catch (error) {
      repository.finishCall(id, 'error', String(error.message ?? error));
      lastError = String(error.message ?? error);
    } finally { inFlight = false; nextAt = now + spacing; }
  }

  /** Geeft schedulerstatus; input: geen; output: quota, zontijden, volgende poging, fout. */
  function status() {
    const now = clock();
    const day = localDay(now);
    const sun = times(day);
    return { source: settings.weather.source, location_configured: locationOk, used_requests: repository.countCalls(day), max_requests: settings.weather.max_requests_per_local_day, sunrise: sun ? new Date(sun.sunrise_ms).toISOString() : null, sunset: sun ? new Date(sun.sunset_ms).toISOString() : null, next_fetch: nextAt ? new Date(nextAt).toISOString() : null, last_call: repository.lastCall() ?? null, last_error: lastError };
  }

  /** Start periodieke achtergrondupdates; input: geen; output: void. */
  function start() { void tick(); interval = setInterval(() => { void tick(); }, 60000); }

  /** Stopt de scheduler; input: geen; output: void. */
  function stop() { if (interval) clearInterval(interval); }

  return { tick, status, start, stop };
}
