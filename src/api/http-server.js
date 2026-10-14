import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../config/load.js';
import { forecastResponse, irradianceResponse } from './forecast.js';
import { productionResponse, metersResponse } from './measurements.js';
import { growattLimitParam, growattOverview, growattFrameDetail } from './growatt-diagnostics.js';
import { getBaseload } from '../appliances/baseload.js';
import { loadProfiles } from '../appliances/load-profiles.js';
import { advise } from '../appliances/start-advice.js';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dashboard', ['index.html', 'text/html; charset=utf-8']],
  ['/growatt', ['growatt.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/growatt.css', ['growatt.css', 'text/css; charset=utf-8']],
  ['/growatt.js', ['growatt.js', 'text/javascript; charset=utf-8']]
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
export function startHttpServer({ settings, panels, panelErrors, repository, weather, homewizard }) {
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Alleen GET beschikbaar' });
    try {
      const url = new URL(request.url, 'http://localhost');
      if (staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'", 'X-Content-Type-Options': 'nosniff' });
        return response.end(readFileSync(join(root, 'public', file)));
      }
      const now = Date.now();
      const forecastRows = (hours) => repository.forecast(now, now + hours * 3600000);
      if (url.pathname === '/api/v1/forecast') return sendJson(response, 200, forecastResponse(forecastRows(hoursParam(url.searchParams.get('hours'), 72)), panels, panelErrors, settings.location, now, settings.weather.stale_after_hours));
      if (url.pathname === '/api/v1/irradiance') return sendJson(response, 200, irradianceResponse(forecastRows(hoursParam(url.searchParams.get('hours'), 72)), panels, panelErrors, settings.location));
      if (url.pathname === '/api/v1/growatt') return sendJson(response, 200, growattOverview(repository, settings, panels, now, growattLimitParam(url.searchParams.get('limit'))));
      if (/^\/api\/v1\/growatt\/frames\/[1-9]\d*$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/')[5]);
        if (!Number.isSafeInteger(id)) throw new Error('Ongeldig pakket-id');
        const frame = growattFrameDetail(repository, id);
        return frame ? sendJson(response, 200, frame) : sendJson(response, 404, { error: 'Pakket niet gevonden' });
      }
      if (url.pathname === '/api/v1/production/current') return sendJson(response, 200, productionResponse(repository.currentInverters(), settings.growatt.expected_inverters, settings.growatt.fresh_minutes, now, panels.inverters.map((item) => item.serial)));
      if (url.pathname === '/api/v1/meters/current') return sendJson(response, 200, metersResponse(repository.currentMeters(), now, settings.homewizard.net_meter_priority));
      if (url.pathname === '/api/v1/appliances') {
        const { profiles, errors } = loadProfiles(join(root, 'config/appliances'));
        return sendJson(response, 200, { profiles: [...profiles.values()], errors });
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
        return sendJson(response, 200, { time: new Date(now).toISOString(), timezone: settings.timezone, weather: sunlight, panels: { expected: panels.expected_panel_count, groups: panels.groups.length, missing: panelErrors }, growatt: { expected_inverters: settings.growatt.expected_inverters, frames: repository.frameStatus(), ...productionResponse(repository.currentInverters(), settings.growatt.expected_inverters, settings.growatt.fresh_minutes, now, panels.inverters.map((item) => item.serial)) }, homewizard: { errors: homewizard.status(), ...metersResponse(repository.currentMeters(), now, settings.homewizard.net_meter_priority) }, baseload: getBaseload(settings, repository, now) });
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
