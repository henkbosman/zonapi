import { localDay } from './local-day.js';
import { addCalendarDays, localDayRange } from './local-calendar.js';

/** Bouwt één Best Match-verzoek met drie uur terugblik en de resterende voorspelde kalenderdagen; input: lat, lon, dagen, optionele resolutie en peiltijd; output: uur-/kwartierhistorie plus dagverwachtingen zonder extra eerdere kalenderdagen. */
export function forecastUrl(latitude, longitude, days, resolutionMinutes = 15, now = Date.now()) {
  const until = localDayRange(addCalendarDays(localDay(now), days - 1)).end_ms;
  const hour = 3600000, quarter = 900000;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), hourly: 'shortwave_radiation,direct_normal_irradiance,diffuse_radiation,cloud_cover,weather_code', daily: 'sunrise,sunset', timezone: 'Europe/Amsterdam', timeformat: 'unixtime', models: 'best_match', forecast_days: String(days),
    past_hours: '3', forecast_hours: String((until - Math.floor(now / hour) * hour) / hour) }).toString();
  if (resolutionMinutes === 15) {
    url.searchParams.set('minutely_15', 'shortwave_radiation,direct_normal_irradiance,diffuse_radiation');
    url.searchParams.set('past_minutely_15', '12');
    url.searchParams.set('forecast_minutely_15', String((until - Math.floor(now / quarter) * quarter) / quarter));
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
  const names = ['shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation'];
  const named = names.some((name) => Object.hasOwn(series, `${name}_${model}`));
  const values = names.map((name) => series[named ? `${name}_${model}` : name]);
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

/** Leest uitsluitend het Best Match-paar of de enkelmodelvelden; input: uurreeks en ontvangsttijd; output: oorspronkelijke uurpunten zonder aanvulling uit ICON-D2 of een andere antwoordvorm. */
function conditionRows(series, fetchedMs) {
  if (!Array.isArray(series?.time)) return [];
  const namedBest = Object.hasOwn(series, 'cloud_cover_best_match') || Object.hasOwn(series, 'weather_code_best_match');
  const covers = namedBest ? series.cloud_cover_best_match : series.cloud_cover;
  const codes = namedBest ? series.weather_code_best_match : series.weather_code;
  return series.time.flatMap((time, index) => {
    if (!Number.isFinite(time)) return [];
    const cover = Array.isArray(covers) && covers.length === series.time.length ? covers[index] : null;
    const code = Array.isArray(codes) && codes.length === series.time.length ? codes[index] : null;
    return [{ source: 'open-meteo', model: 'best_match',
      cloud_cover: Number.isFinite(cover) && cover >= 0 && cover <= 100 ? cover : null,
      weather_code: Number.isInteger(code) && code >= 0 && code <= 99 ? code : null, time_ms: time * 1000, fetched_ms: fetchedMs }];
  });
}

/** Normaliseert kwartier-, uur- en zonwaarden; input: API JSON, ophaaltijd en optionele resolutie; output: alle bronrijen en zonnedagen. */
export function normalizeOpenMeteo(json, fetchedMs, resolutionMinutes = 15) {
  const rows = [...radiationRows(json.hourly, 'best_match', 3600, fetchedMs),
    ...(resolutionMinutes === 15 ? radiationRows(json.minutely_15, 'best_match', 900, fetchedMs) : [])];
  if (!rows.length) throw new Error('Geen geldige instralingsvoorspelling');
  const sun = [];
  const rises = json.daily?.sunrise_best_match ?? json.daily?.sunrise ?? [];
  const sets = json.daily?.sunset_best_match ?? json.daily?.sunset ?? [];
  for (let index = 0; index < rises.length; index++) {
    const sunrise = Number.isFinite(rises[index]) ? rises[index] * 1000 : NaN;
    const sunset = Number.isFinite(sets[index]) ? sets[index] * 1000 : NaN;
    if (Number.isFinite(sunrise) && Number.isFinite(sunset) && sunset > sunrise) sun.push({ day: localDay(sunrise), sunrise_ms: sunrise, sunset_ms: sunset });
  }
  return { rows, sun, conditions: conditionRows(json.hourly, fetchedMs) };
}

/** Haalt uitsluitend Open-Meteo-voorspellingen op; input: locatie, dagen, optionele resolutie en fetch-functie; output: genormaliseerde rijen en HTTP-metadata of fout met metadata. */
export async function fetchOpenMeteo({ latitude, longitude, days, resolutionMinutes = 15, fetcher = fetch }) {
  const started = Date.now();
  const url = forecastUrl(latitude, longitude, days, resolutionMinutes, started);
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
