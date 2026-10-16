import { localDay } from './local-day.js';
import { offlineSunTimes } from './solar-position.js';
import { getIrradianceSource } from './irradiance-source.js';
import { estimatePv } from '../pv/model.js';
import { getCalibrationFactor } from '../pv/calibration.js';
import { getWeatherResolution } from './resolution.js';

/** Maakt een daglichtgestuurde weerscheduler; input: instellingen, panelen, fouten, repository, optionele klok/bron; output: {tick,status,start,stop}. */
export function createWeatherScheduler({ settings, panels, panelErrors, repository, clock = () => Date.now(), source = getIrradianceSource(settings.weather.source) }) {
  let interval = null;
  let inFlight = false;
  let lastError = null;
  let nextAt = null;
  const calibrationFactor = getCalibrationFactor(settings);
  const resolutionMinutes = getWeatherResolution(settings);
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

  /** Plant ophaalpoging binnen daglicht en quotum; input: force om alleen het tijdsinterval over te slaan; output: Promise<{attempted,reason,status}>. */
  async function tick(force = false) {
    const now = clock();
    const day = localDay(now);
    const sun = times(day);
    nextAt = sun?.sunrise_ms ?? null;
    if (!locationOk) return { attempted: false, reason: 'location', status: status() };
    if (!sun) return { attempted: false, reason: 'sun_times', status: status() };
    if (!settings.weather.max_requests_per_local_day) { nextAt = null; return { attempted: false, reason: 'paused', status: status() }; }
    if (inFlight) return { attempted: false, reason: 'busy', status: status() };
    if (now < sun.sunrise_ms) return { attempted: false, reason: 'before_sunrise', status: status() };
    if (now >= sun.sunset_ms) { nextAt = tomorrowSunrise(day); return { attempted: false, reason: 'after_sunset', status: status() }; }
    const max = settings.weather.max_requests_per_local_day;
    const used = repository.countCalls(day);
    if (used >= max) { nextAt = tomorrowSunrise(day); return { attempted: false, reason: 'quota', status: status() }; }
    const last = repository.lastCall();
    const spacing = Math.max(3600000, (sun.sunset_ms - sun.sunrise_ms) / Math.max(1, max - 1));
    const minimum = last?.local_date === day && last.status === 'error' ? Math.max(spacing, settings.weather.retry_minutes * 60000) : spacing;
    nextAt = last?.local_date === day ? last.attempted_ms + minimum : sun.sunrise_ms;
    if (!force && now < nextAt) return { attempted: false, reason: 'interval', status: status() };
    inFlight = true;
    const id = repository.beginCall(day, now, settings.weather.source);
    try {
      const result = await source({ latitude, longitude, days: settings.weather.forecast_days, resolutionMinutes });
      const db = repository.database();
      db.exec('BEGIN');
      try {
        for (const item of result.sun) repository.saveSun(item.day, item.sunrise_ms, item.sunset_ms, settings.weather.source, now);
        for (const row of result.rows) {
          repository.saveForecast(row);
          if (!panelErrors.length) {
            const pv = estimatePv(row, panels, latitude, longitude, calibrationFactor);
            for (const group of pv.groups) repository.savePv({ ...row, ...group, source: row.source });
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      repository.finishCall(id, 'ok', {
        detail: `${result.rows.length} punten · ${result.sun.length} zonnedagen`,
        request_url: result.request?.url ?? null, http_status: result.request?.http_status ?? null,
        duration_ms: result.request?.duration_ms ?? null,
        forecast_rows: result.rows.length, sun_days: result.sun.length
      });
      lastError = null;
    } catch (error) {
      repository.finishCall(id, 'error', {
        detail: String(error.message ?? error), request_url: error.request_url ?? null,
        http_status: error.http_status ?? null, duration_ms: error.duration_ms ?? null
      });
      lastError = String(error.message ?? error);
    } finally { inFlight = false; nextAt = now + spacing; }
    return { attempted: true, reason: repository.lastCall()?.status ?? 'error', status: status() };
  }

  /** Geeft schedulerstatus; input: geen; output: quota, zontijden, volgende poging, fout. */
  function status() {
    const now = clock();
    const day = localDay(now);
    const sun = times(day);
    const lastCall = repository.lastCall() ?? null;
    return { source: settings.weather.source, preferred_resolution_minutes: resolutionMinutes, location_configured: locationOk, fetching: inFlight, used_requests: repository.countCalls(day), max_requests: settings.weather.max_requests_per_local_day, sunrise: sun ? new Date(sun.sunrise_ms).toISOString() : null, sunset: sun ? new Date(sun.sunset_ms).toISOString() : null, next_fetch: nextAt ? new Date(nextAt).toISOString() : null, last_call: lastCall, last_error: lastError ?? (lastCall?.status === 'error' ? lastCall.detail : null) };
  }

  /** Probeert op verzoek eenmaal op te halen binnen daglicht en quotum; input: geen; output: Promise met ophaalresultaat. */
  function refresh() { return tick(true); }

  /** Start periodieke achtergrondupdates; input: geen; output: void. */
  function start() { void tick(); interval = setInterval(() => { void tick(); }, 60000); }

  /** Stopt de scheduler; input: geen; output: void. */
  function stop() { if (interval) clearInterval(interval); }

  return { tick, refresh, status, start, stop };
}
