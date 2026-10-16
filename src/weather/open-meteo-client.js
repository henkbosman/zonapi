import { localDay } from './local-day.js';

/** Bouwt één gecombineerd weerverzoek; input: lat, lon, dagen en optionele resolutie; output: URL met uurterugval en bij 15 minuten ICON-D2-kwartierdata. */
export function forecastUrl(latitude, longitude, days, resolutionMinutes = 15) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), hourly: 'shortwave_radiation,direct_normal_irradiance,diffuse_radiation', daily: 'sunrise,sunset', timezone: 'Europe/Amsterdam', timeformat: 'unixtime', forecast_days: String(days) }).toString();
  if (resolutionMinutes === 15) {
    url.searchParams.set('minutely_15', 'shortwave_radiation,direct_normal_irradiance,diffuse_radiation');
    url.searchParams.set('forecast_minutely_15', '192');
    url.searchParams.set('past_minutely_15', '96');
    url.searchParams.set('models', 'best_match,icon_d2');
  }
  return url;
}

/** Leest de foutreden van Open-Meteo; input: HTTP-response; output: tekst tot 600 tekens. */
async function responseReason(response) {
  const body = (await response.text()).slice(0, 2000);
  try {
    const json = JSON.parse(body);
    return String(json.reason ?? json.error ?? body).slice(0, 600);
  } catch { return body.trim().slice(0, 600); }
}

/** Normaliseert één modelreeks met voorafgaande gemiddelden; input: reeks, modelnaam, stap in seconden en ophaaltijd; output: geldige tijdvakken of fout bij ongelijk lange arrays. */
function radiationRows(series, model, stepSeconds, fetchedMs) {
  if (!series?.time?.length) return [];
  const time = series.time;
  const values = ['shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation'].map((name) => series[`${name}_${model}`] ?? series[name]);
  if (values.every((value) => value === undefined)) return [];
  if (!values.every((value) => Array.isArray(value) && value.length === time.length)) throw new Error(`Onvolledige Open-Meteo-${stepSeconds === 900 ? 'kwartier' : 'uur'}reeks`);
  const rows = [];
  for (let index = 0; index < time.length; index++) {
    if (![time[index], ...values.map((value) => value[index])].every(Number.isFinite)) continue;
    rows.push({ source: 'open-meteo', model, start_ms: (time[index] - stepSeconds) * 1000, end_ms: time[index] * 1000,
      ghi: Math.max(0, values[0][index]), dni: Math.max(0, values[1][index]), dhi: Math.max(0, values[2][index]), fetched_ms: fetchedMs });
  }
  return rows;
}

/** Normaliseert kwartier-, uur- en zonwaarden; input: API JSON, ophaaltijd en optionele resolutie; output: alle bronrijen en zonnedagen. */
export function normalizeOpenMeteo(json, fetchedMs, resolutionMinutes = 15) {
  const rows = [...radiationRows(json.hourly, 'best_match', 3600, fetchedMs),
    ...(resolutionMinutes === 15 ? radiationRows(json.minutely_15, 'icon_d2', 900, fetchedMs) : [])];
  if (!rows.length) throw new Error('Geen geldige instralingsvoorspelling');
  const sun = [];
  const rises = json.daily?.sunrise_best_match ?? json.daily?.sunrise ?? [];
  const sets = json.daily?.sunset_best_match ?? json.daily?.sunset ?? [];
  for (let index = 0; index < rises.length; index++) {
    const sunrise = Number.isFinite(rises[index]) ? rises[index] * 1000 : NaN;
    const sunset = Number.isFinite(sets[index]) ? sets[index] * 1000 : NaN;
    if (Number.isFinite(sunrise) && Number.isFinite(sunset) && sunset > sunrise) sun.push({ day: localDay(sunrise), sunrise_ms: sunrise, sunset_ms: sunset });
  }
  return { rows, sun };
}

/** Haalt uitsluitend Open-Meteo-voorspellingen op; input: locatie, dagen, optionele resolutie en fetch-functie; output: genormaliseerde rijen en HTTP-metadata of fout met metadata. */
export async function fetchOpenMeteo({ latitude, longitude, days, resolutionMinutes = 15, fetcher = fetch }) {
  const url = forecastUrl(latitude, longitude, days, resolutionMinutes);
  const started = Date.now();
  let response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      const reason = await responseReason(response);
      throw new Error(`Open-Meteo HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
    }
    const result = normalizeOpenMeteo(await response.json(), Date.now(), resolutionMinutes);
    return { ...result, request: { url: url.toString(), http_status: response.status, duration_ms: Date.now() - started } };
  } catch (error) {
    error.request_url = url.toString();
    error.http_status = response?.status ?? null;
    error.duration_ms = Date.now() - started;
    throw error;
  }
}
