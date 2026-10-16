import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../config/load.js';
import { forecastResponse, irradianceResponse } from './forecast.js';
import { productionResponse, metersResponse } from './measurements.js';
import { productionSeries } from './production-series.js';
import { growattLimitParam, growattOverview, growattFrameDetail, growattTimelineParams, growattTimeline } from './growatt-diagnostics.js';
import { weatherCallParams, weatherOverview } from './weather-diagnostics.js';
import { homeWizardCallParams, homeWizardOverview } from './homewizard-diagnostics.js';
import { diagnosticAction } from './diagnostic-actions.js';
import { growattListenerStatus } from '../growatt/listener-status.js';
import { getBaseload } from '../appliances/baseload.js';
import { loadProfiles } from '../appliances/load-profiles.js';
import { advise } from '../appliances/start-advice.js';
import { dailyAdvice } from '../appliances/daily-advice.js';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard', ['index.html', 'text/html; charset=utf-8']],
  ['/growatt', ['growatt.html', 'text/html; charset=utf-8']],
  ['/weather', ['weather.html', 'text/html; charset=utf-8']],
  ['/homewizard', ['homewizard.html', 'text/html; charset=utf-8']],
  ['/homewizard.js', ['homewizard.js', 'text/javascript; charset=utf-8']],
  ['/diagnostic-controls.js', ['diagnostic-controls.js', 'text/javascript; charset=utf-8']],
  ['/chart-cursor.js', ['chart-cursor.js', 'text/javascript; charset=utf-8']],
  ['/dashboard-daily-advice.js', ['dashboard-daily-advice.js', 'text/javascript; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/dashboard-production-chart.js', ['dashboard-production-chart.js', 'text/javascript; charset=utf-8']],
  ['/growatt.css', ['growatt.css', 'text/css; charset=utf-8']],
  ['/growatt.js', ['growatt.js', 'text/javascript; charset=utf-8']],
  ['/weather.css', ['weather.css', 'text/css; charset=utf-8']],
  ['/weather.js', ['weather.js', 'text/javascript; charset=utf-8']],
  ['/weather-chart.js', ['weather-chart.js', 'text/javascript; charset=utf-8']]
]);

/** Schrijft JSON met vaste beveiligingsheaders; input: HTTP-response, statuscode, object; output: void. */
export function sendJson(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

/** Leest begrensde urenparameter; input: querywaarde en maximum; output: positief aantal uren of fout. */
export function hoursParam(value, maximum) {
  const hours = Number(value ?? 3);
  if (!Number.isFinite(hours) || hours <= 0 || hours > maximum) throw new Error(`hours moet >0 en <=${maximum} zijn`);
  return hours;
}

/** Leest een ISO-tijdstip; input: querywaarde en standaardwaarde; output: epoch-ms of fout. */
export function timeParam(value, defaultMs) {
  if (value === null) return defaultMs;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('Tijdstip moet ISO 8601 met offset/Z zijn');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('Ongeldig tijdstip');
  return ms;
}

/** Start een leesbare LAN-API met dashboard; input: dienstafhankelijkheden; output: luisterende http.Server. */
export function startHttpServer({ settings, panels, panelErrors, repository, weather, homewizard, growattRuntime }) {
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const action = diagnosticAction(request.method, url, repository);
      if (action !== null) return sendJson(response, 200, action);
      if (request.method === 'POST' && url.pathname === '/api/v1/weather/refresh') {
        if (typeof weather.refresh !== 'function') return sendJson(response, 503, { error: 'Weerscheduler niet beschikbaar' });
        void weather.refresh().then((result) => sendJson(response, 200, result)).catch((error) => sendJson(response, 500, { error: error.message }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/homewizard/poll') {
        if (typeof homewizard.poll !== 'function') return sendJson(response, 503, { error: 'Meterpoller niet beschikbaar' });
        void homewizard.poll().then((result) => sendJson(response, 200, result)).catch((error) => sendJson(response, 500, { error: error.message }));
        return;
      }
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Methode niet beschikbaar' });
      if (staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'", 'X-Content-Type-Options': 'nosniff' });
        return response.end(readFileSync(join(root, 'public', file)));
      }
      const now = Date.now();
      const forecastRows = (hours) => repository.forecast(now, now + hours * 3600000);
      if (url.pathname === '/api/v1/forecast') return sendJson(response, 200, forecastResponse(forecastRows(hoursParam(url.searchParams.get('hours'), 72)), panels, panelErrors, settings.location, now, settings.weather.stale_after_hours));
      if (url.pathname === '/api/v1/irradiance') return sendJson(response, 200, irradianceResponse(forecastRows(hoursParam(url.searchParams.get('hours'), 72)), panels, panelErrors, settings.location));
      if (url.pathname === '/api/v1/growatt') return sendJson(response, 200, growattOverview(repository, settings, panels, now, growattLimitParam(url.searchParams.get('limit')), growattRuntime));
      if (url.pathname === '/api/v1/weather') return sendJson(response, 200, weatherOverview(repository, settings, weather, now, weatherCallParams(url.searchParams)));
      if (url.pathname === '/api/v1/homewizard') return sendJson(response, 200, homeWizardOverview(repository, settings, homewizard, now, homeWizardCallParams(url.searchParams)));
      if (url.pathname === '/api/v1/growatt/timeline') return sendJson(response, 200, growattTimeline(repository, growattTimelineParams(url.searchParams)));
      if (/^\/api\/v1\/growatt\/frames\/[1-9]\d*$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/')[5]);
        if (!Number.isSafeInteger(id)) throw new Error('Ongeldig pakket-id');
        const frame = growattFrameDetail(repository, id);
        return frame ? sendJson(response, 200, frame) : sendJson(response, 404, { error: 'Pakket niet gevonden' });
      }
      if (url.pathname === '/api/v1/production/current') return sendJson(response, 200, productionResponse(repository.currentInverters(), settings.growatt.expected_inverters, settings.growatt.fresh_minutes, now, panels.inverters.map((item) => item.serial)));
      if (url.pathname === '/api/v1/production/day') {
        const { sunrise, sunset } = weather.status();
        const from = sunrise ? Date.parse(sunrise) : now - 26 * 3600000;
        const to = Math.min(now, sunset ? Date.parse(sunset) : now) + 1;
        const rows = to > from ? repository.history('inverter', from, to, 5000) : [];
        return sendJson(response, 200, {
          sunrise: sunrise ?? null, sunset: sunset ?? null, now: new Date(now).toISOString(), fresh_minutes: settings.growatt.fresh_minutes,
          points: productionSeries(rows, now, sunrise, sunset, settings.growatt.expected_inverters, settings.growatt.fresh_minutes, panels.inverters.map((item) => item.serial))
        });
      }
      if (url.pathname === '/api/v1/meters/current') return sendJson(response, 200, metersResponse(repository.currentMeters(), now, settings.homewizard.net_meter_priority));
      if (url.pathname === '/api/v1/appliances') {
        const { profiles, errors } = loadProfiles(join(root, 'config/appliances'));
        return sendJson(response, 200, { profiles: [...profiles.values()], errors });
      }
      if (url.pathname === '/api/v1/appliances/daily') {
        const { profiles, errors } = loadProfiles(join(root, 'config/appliances'));
        const rows = forecastRows((settings.weather.forecast_days + 1) * 24);
        return sendJson(response, 200, { ...dailyAdvice([...profiles.values()], rows,
          { settings, panels, panelErrors, latitude: settings.location.latitude, longitude: settings.location.longitude,
            baseload: getBaseload(settings, repository, now), now }, repository), errors });
      }
      if (/^\/api\/v1\/appliances\/[a-z0-9_-]+\/advice$/.test(url.pathname)) {
        const id = url.pathname.split('/')[4];
        const profile = loadProfiles(join(root, 'config/appliances')).profiles.get(id);
        if (!profile) return sendJson(response, 404, { error: 'Onbekend of ongeldig apparaatprofiel' });
        const durationHours = profile.duration_minutes / 60;
        const rows = forecastRows(settings.advice.search_hours + durationHours + 1);
        const advice = advise(profile, rows, { settings, panels, panelErrors, latitude: settings.location.latitude, longitude: settings.location.longitude, baseload: getBaseload(settings, repository, now), now });
        return sendJson(response, 200, advice);
      }
      if (url.pathname === '/api/v1/history') {
        const from = timeParam(url.searchParams.get('from'), now - 86400000);
        const to = timeParam(url.searchParams.get('to'), now);
        if (to <= from || to - from > 366 * 86400000) throw new Error('Tijdsbereik ongeldig (max. 366 dagen)');
        const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') ?? 2000)));
        if (!Number.isInteger(limit)) throw new Error('limit moet een geheel getal zijn');
        const metric = url.searchParams.get('metric') ?? 'inverter';
        return sendJson(response, 200, { metric, from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit, rows: repository.history(metric, from, to, limit) });
      }
      if (url.pathname === '/api/v1/status') {
        const sunlight = weather.status();
        return sendJson(response, 200, { time: new Date(now).toISOString(), timezone: settings.timezone, weather: sunlight, panels: { expected: panels.expected_panel_count, groups: panels.groups.length, missing: panelErrors }, growatt: { listener: growattListenerStatus(growattRuntime, settings.growatt), database_path: repository.databasePath(), expected_inverters: settings.growatt.expected_inverters, frames: repository.frameStatus(), ...productionResponse(repository.currentInverters(), settings.growatt.expected_inverters, settings.growatt.fresh_minutes, now, panels.inverters.map((item) => item.serial)) }, homewizard: { errors: homewizard.status(), ...metersResponse(repository.currentMeters(), now, settings.homewizard.net_meter_priority) }, baseload: getBaseload(settings, repository, now) });
      }
      return sendJson(response, 404, { error: 'Endpoint bestaat niet' });
    } catch (error) {
      console.error('API:', error.message);
      return sendJson(response, 400, { error: error.message });
    }
  });
  server.listen(settings.http.port, settings.http.host);
  return server;
}
