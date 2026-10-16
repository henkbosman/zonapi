import { localDay } from '../weather/local-day.js';
import { irradianceRequestUrl } from '../weather/irradiance-source.js';

/** Leest statusfilter en paginering voor weerpogingen; input: URLSearchParams; output: {status,limit,offset} of fout. */
export function weatherCallParams(params) {
  const limit = params.get('limit') ?? '50';
  const offset = params.get('offset') ?? '0';
  const status = params.get('status') ?? 'all';
  if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) throw new Error('limit moet 1..100 zijn');
  if (!/^(?:0|[1-9]\d{0,6})$/.test(offset)) throw new Error('offset moet 0..9999999 zijn');
  if (!['all', 'ok', 'error', 'pending'].includes(status)) throw new Error('status moet all, ok, error of pending zijn');
  return { status, limit: Number(limit), offset: Number(offset) };
}

/** Stelt weerdiagnostiek samen uit bestaande cache en aanvraaghistorie; input: repository, instellingen, scheduler, huidige ms en filters; output: JSON-overzicht. */
export function weatherOverview(repository, settings, scheduler, now, filters) {
  const state = scheduler.status();
  const day = localDay(now);
  const sunshine = state.sunrise && state.sunset ? { sunrise: state.sunrise, sunset: state.sunset } : null;
  const rows = sunshine ? repository.forecast(Date.parse(sunshine.sunrise), Date.parse(sunshine.sunset)) : [];
  const page = repository.recentWeatherCalls(filters.status, filters.limit, filters.offset);
  const location = settings.location ?? {};
  const validLocation = state.location_configured === true;
  return {
    server_time: new Date(now).toISOString(),
    logging: repository.loggingStatus('weather'),
    status: state,
    location: { latitude: location.latitude ?? null, longitude: location.longitude ?? null },
    forecast_days: settings.weather.forecast_days,
    request_url: validLocation ? irradianceRequestUrl(settings.weather.source, { ...location, days: settings.weather.forecast_days }) : null,
    last_success: repository.lastSuccessfulWeatherCall() ?? null,
    forecast: { day, ...sunshine, rows: rows.map((row) => ({
      start: new Date(row.start_ms).toISOString(), end: new Date(row.end_ms).toISOString(),
      ghi_w_m2: row.ghi, dni_w_m2: row.dni, dhi_w_m2: row.dhi, fetched_at: new Date(row.fetched_ms).toISOString()
    })) },
    calls: { ...filters, has_more: page.has_more, rows: page.rows.map((row) => ({ ...row, attempted_at: new Date(row.attempted_ms).toISOString() })) }
  };
}
