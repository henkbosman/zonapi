import { localDay } from './local-day.js';
import { offlineSunTimes } from './solar-position.js';
import { getIrradianceSource } from './irradiance-source.js';
import { createPvForecastModel } from '../pv/forecast-model.js';
import { forecastTimeline } from './forecast-timeline.js';
import { getWeatherResolution } from './resolution.js';
import { getWeatherPollMinutes } from './poll-interval.js';
import { weatherLocationKey } from './clear-sky.js';

/** Maakt een weerscheduler met een vast minuteninterval; input: instellingen, panelen, fouten, repository en optionele klok/bron/correctiecallback; output: {tick,refresh,status,start,stop}. */
export function createWeatherScheduler({ settings, panels, panelErrors, repository, clock = () => Date.now(), source = getIrradianceSource(settings.weather.source), onForecast }) {
  let interval = null;
  let inFlight = false;
  let lastError = null;
  const resolutionMinutes = getWeatherResolution(settings);
  const pollMinutes = getWeatherPollMinutes(settings);
  const latitude = settings.location?.latitude;
  const longitude = settings.location?.longitude;
  const locationOk = Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;

  /** Geeft zontijden uit cache of offline berekening; input: lokale dag; output: grenzen of null. */
  function times(day) {
    return repository.getSun(day) ?? (locationOk ? offlineSunTimes(day, latitude, longitude) : null);
  }

  /** Plant vanaf de laatste poging met een vast interval en foutterugval; input: huidige ms; output: {reason,next_ms} zonder netwerkverzoek. */
  function plan(now) {
    if (!locationOk) return { reason: 'location', next_ms: null };
    if (!pollMinutes) return { reason: 'paused', next_ms: null };
    const last = repository.lastCall();
    const spacing = pollMinutes * 60000;
    const wait = Math.max(spacing, last?.status === 'error' ? settings.weather.retry_minutes * 60000 : 0);
    const next = last ? last.attempted_ms + wait : now;
    return { reason: now < next ? 'interval' : 'ready', next_ms: Math.max(now, next) };
  }

  /** Haalt instraling overdag en 's nachts op binnen het interval; input: force om het interval over te slaan; output: Promise<{attempted,reason,status}>. */
  async function tick(force = false) {
    const now = clock();
    const day = localDay(now);
    if (inFlight) return { attempted: false, reason: 'busy', status: status() };
    const scheduled = plan(now);
    if (scheduled.reason !== 'ready' && !(force && scheduled.reason === 'interval')) return { attempted: false, reason: scheduled.reason, status: status() };
    inFlight = true;
    const id = repository.beginCall(day, now, settings.weather.source);
    try {
      const result = await source({ latitude, longitude, days: Math.max(3, settings.weather.forecast_days), resolutionMinutes });
      const db = repository.database();
      db.exec('BEGIN');
      try {
        for (const item of result.sun) repository.saveSun(item.day, item.sunrise_ms, item.sunset_ms, settings.weather.source, now);
        for (const row of result.rows) {
          repository.saveForecast(row);
        }
        for (const row of result.conditions ?? []) repository.saveWeatherCondition(weatherLocationKey(settings.location), row);
        repository.pruneClearSkyHistory(now);
        if (!panelErrors.length) {
          const model = createPvForecastModel(repository, settings, panels, now);
          const rows = model.active ? forecastTimeline(result.rows, -Infinity, Infinity) : result.rows;
          for (const row of model.prepare(rows)) {
            const pv = model.estimate(row);
            for (const group of pv.groups) repository.savePv({ ...row, ...group, correction_factor: pv.correction_factor, computed_ms: now, model_key: model.modelKey });
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
      try { onForecast?.(clock()); }
      catch (error) { repository.saveGrowattEvent(clock(), 'weather', 'forecast_correction_error', String(error.message ?? error).slice(0, 500)); }
    } catch (error) {
      repository.finishCall(id, 'error', {
        detail: String(error.message ?? error), request_url: error.request_url ?? null,
        http_status: error.http_status ?? null, duration_ms: error.duration_ms ?? null
      });
      lastError = String(error.message ?? error);
    } finally { inFlight = false; }
    return { attempted: true, reason: repository.lastCall()?.status ?? 'error', status: status() };
  }

  /** Geeft schedulerstatus; input: geen; output: interval, informatieve dagteller, zontijden, volgende poging en fout. */
  function status() {
    const now = clock();
    const day = localDay(now);
    const sun = times(day);
    const lastCall = repository.lastCall() ?? null;
    const next = plan(now).next_ms;
    return { source: settings.weather.source, preferred_resolution_minutes: resolutionMinutes, location_configured: locationOk, fetching: inFlight, used_requests: repository.countCalls(day), poll_minutes: pollMinutes, sunrise: sun ? new Date(sun.sunrise_ms).toISOString() : null, sunset: sun ? new Date(sun.sunset_ms).toISOString() : null, next_fetch: next === null ? null : new Date(next).toISOString(), last_call: lastCall, last_error: lastError ?? (lastCall?.status === 'error' ? lastCall.detail : null) };
  }

  /** Probeert op verzoek eenmaal op te halen, met behoud van pauze en overlapbeveiliging; input: geen; output: Promise met ophaalresultaat. */
  function refresh() { return tick(true); }

  /** Start periodieke achtergrondupdates; input: geen; output: void. */
  function start() { void tick(); interval = setInterval(() => { void tick(); }, 60000); }

  /** Stopt de scheduler; input: geen; output: void. */
  function stop() { if (interval) clearInterval(interval); }

  return { tick, refresh, status, start, stop };
}
