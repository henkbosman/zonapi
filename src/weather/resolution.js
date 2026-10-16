/** Leest de gewenste weerresolutie; input: instellingen; output: 15 of 60 minuten, standaard 15, of fout. */
export function getWeatherResolution(settings) {
  const value = settings.weather?.resolution_minutes === undefined ? 15 : settings.weather.resolution_minutes;
  if (![15, 60].includes(value)) throw new Error('weather.resolution_minutes moet 15 of 60 zijn');
  return value;
}

/** Vat de gebruikte bronresoluties samen; input: voorspelde tijdvakken; output: kleinste resolutie en alle voorkomende bronresoluties. */
export function forecastResolution(rows) {
  const resolutions = [...new Set(rows.map((row) => row.source_resolution_minutes ?? (row.end_ms - row.start_ms) / 60000))].sort((a, b) => a - b);
  return { resolution_minutes: resolutions[0] ?? null, resolutions_minutes: resolutions, mixed_resolution: resolutions.length > 1 };
}
