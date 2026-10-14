import { localDay } from './local-day.js';

/** Bouwt Forecast API-verzoek voor één locatie; input: lat, lon, aantal dagen; output: URL. */
export function forecastUrl(latitude, longitude, days) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), hourly: 'shortwave_radiation,direct_normal_irradiance,diffuse_radiation', daily: 'sunrise,sunset', timezone: 'Europe/Amsterdam', timeformat: 'unixtime', forecast_days: String(days), models: 'auto' }).toString();
  return url;
}

/** Normaliseert Open-Meteo-uur- en dagwaarden; input: API JSON en ophaaltijd ms; output: {rows, sun}. */
export function normalizeOpenMeteo(json, fetchedMs) {
  const hourly = json.hourly ?? {};
  const { time = [], shortwave_radiation: ghi = [], direct_normal_irradiance: dni = [], diffuse_radiation: dhi = [] } = hourly;
  if (![ghi, dni, dhi].every((values) => values.length === time.length) || !time.length) throw new Error('Onvolledige Open-Meteo-uurreeks');
  const rows = [];
  for (let index = 0; index < time.length; index++) {
    if (![time[index], ghi[index], dni[index], dhi[index]].every(Number.isFinite)) continue;
    // Open-Meteo geeft zoninstraling als gemiddelde van het voorafgaande uur.
    rows.push({ source: 'open-meteo', start_ms: (time[index] - 3600) * 1000, end_ms: time[index] * 1000, ghi: Math.max(0, ghi[index]), dni: Math.max(0, dni[index]), dhi: Math.max(0, dhi[index]), fetched_ms: fetchedMs });
  }
  if (!rows.length) throw new Error('Geen geldige instralingsvoorspelling');
  const sun = [];
  for (let index = 0; index < (json.daily?.sunrise?.length ?? 0); index++) {
    const sunrise = json.daily.sunrise[index] * 1000;
    const sunset = json.daily.sunset?.[index] * 1000;
    if (Number.isFinite(sunrise) && Number.isFinite(sunset) && sunset > sunrise) sun.push({ day: localDay(sunrise), sunrise_ms: sunrise, sunset_ms: sunset });
  }
  return { rows, sun };
}

/** Haalt uitsluitend Open-Meteo-voorspellingen op; input: locatie, dagen, optionele fetch-functie; output: genormaliseerde rijen. */
export async function fetchOpenMeteo({ latitude, longitude, days, fetcher = fetch }) {
  const response = await fetcher(forecastUrl(latitude, longitude, days), { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  return normalizeOpenMeteo(await response.json(), Date.now());
}
