const hour = 3600000, quarter = 900000;
const iso = (ms) => new Date(ms).toISOString();

/** Scheidt weerpunten van verschillende locaties; input: locatie; output: vaste locatiesleutel zonder afronding. */
export function weatherLocationKey(location) { return JSON.stringify([location.latitude, location.longitude]); }

/** Toetst een volledig geldig weerpaar aan de maximale bewolking; input: uurpunt en optionele procentgrens; output: clear voor binnen de grens, cloudy voor erboven, unknown bij ongeldige bronvelden. */
export function skyCondition(row, maxCloudCoverPercent = 0) {
  if (!Number.isFinite(row?.cloud_cover) || row.cloud_cover < 0 || row.cloud_cover > 100
    || !Number.isInteger(row.weather_code) || row.weather_code < 0 || row.weather_code > 99) return 'unknown';
  return row.cloud_cover <= maxCloudCoverPercent ? 'clear' : 'cloudy';
}

/** Omvat het kwartier plus een heel uur aan beide kanten en de omringende echte uurpunten; input: blokeindtijd; output: oorspronkelijke en conservatieve controletijden. */
export function clearSkyBounds(end) {
  const start = end - quarter - hour, until = end + hour;
  return { start, end: until, from: Math.floor(start / hour) * hour, until: Math.ceil(until / hour) * hour };
}

/** Controleert of alle beschikbare modelpunten binnen de bewolkingsgrens vallen; input: opslag, locatie, blokeinde, peiltijd en optionele procentgrens; output: afwijsstatus of clear zonder op toekomstige uurpunten te wachten. */
export function checkClearSky(repository, location, end, now, maxCloudCoverPercent = 0) {
  const bounds = clearSkyBounds(end);
  const times = [];
  for (let time = bounds.from; time <= bounds.until; time += hour) times.push(time);
  const result = { window_start: iso(bounds.start), window_end: iso(bounds.end),
    checked_from: iso(bounds.from), checked_until: iso(bounds.until), uses_forecast: bounds.until > now,
    required_samples: times.length, resolution_minutes: 60, max_allowed_cloud_cover_percent: maxCloudCoverPercent };
  const byTime = new Map(repository.weatherConditions(weatherLocationKey(location), bounds.from, bounds.until).map((row) => [row.time_ms, row]));
  const rows = times.map((time) => byTime.get(time));
  const missing = times.filter((time, index) => !rows[index] || skyCondition(rows[index], maxCloudCoverPercent) === 'unknown');
  if (missing.length) return { status: 'clear_sky_data_missing', ...result, missing_times: missing.map(iso) };
  const unavailable = rows.filter((row) => row.fetched_ms > now);
  if (unavailable.length) return { status: 'waiting_for_clear_sky_data', ...result, missing_times: unavailable.map((row) => iso(row.time_ms)) };
  const samples = rows.map((row) => ({ time: iso(row.time_ms), cloud_cover_percent: row.cloud_cover,
    weather_code: row.weather_code, fetched_at: iso(row.fetched_ms) }));
  return { status: rows.every((row) => skyCondition(row, maxCloudCoverPercent) === 'clear') ? 'clear' : 'clouds_present', ...result,
    checked_samples: rows.length, max_cloud_cover_percent: Math.max(...rows.map((row) => row.cloud_cover)), checked_at: iso(now), samples };
}
