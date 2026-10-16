import { estimatePv } from '../pv/model.js';
import { tiltedIrradiance } from '../pv/plane-irradiance.js';
import { forecastResolution } from '../weather/resolution.js';

/** Vormt opgeslagen weertijdvakken om naar een forecast-API-resultaat; input: rijen, paneelconfig, fouten, locatie, tijd, versheid en optionele kalibratiefactor; output: rijen met gekalibreerde PV, resoluties en kwaliteitsstatus. */
export function forecastResponse(rows, panels, panelErrors, location, now, staleHours, calibrationFactor = 1) {
  const complete = panelErrors.length === 0 && Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
  const stale = rows.some((row) => now - row.fetched_ms > staleHours * 3600000);
  const slots = rows.map((row) => {
    const result = complete ? estimatePv(row, panels, location.latitude, location.longitude, calibrationFactor) : null;
    return { ...slotMetadata(row), ghi_w_m2: row.ghi, dni_w_m2: row.dni, dhi_w_m2: row.dhi, power_w: result?.power_w ?? null, groups: result?.groups ?? null };
  });
  return { status: rows.length ? (complete ? (stale ? 'stale' : 'ok') : 'configuration_incomplete') : 'forecast_unavailable', missing: complete ? [] : panelErrors, calibration_factor: calibrationFactor, ...forecastResolution(rows), slots };
}

/** Beschrijft één effectief voorspeltijdvak; input: opgeslagen rij; output: ISO-grenzen, bron, model en oorspronkelijke en effectieve resolutie. */
export function slotMetadata(row) {
  return { start: new Date(row.start_ms).toISOString(), end: new Date(row.end_ms).toISOString(),
    source: row.source, model: row.model ?? null, fetched_at: new Date(row.fetched_ms).toISOString(),
    resolution_minutes: (row.end_ms - row.start_ms) / 60000,
    source_resolution_minutes: row.source_resolution_minutes ?? (row.end_ms - row.start_ms) / 60000 };
}

/** Vormt weertijdvakken om naar instralings-API-resultaat; input: rijen, panelen, fouten en locatie; output: GHI/DNI/DHI, resoluties en GTI per groep. */
export function irradianceResponse(rows, panels, panelErrors, location) {
  const complete = !panelErrors.length && Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
  return { status: rows.length ? 'ok' : 'forecast_unavailable', ...forecastResolution(rows), slots: rows.map((row) => ({ ...slotMetadata(row), ghi_w_m2: row.ghi, dni_w_m2: row.dni, dhi_w_m2: row.dhi, groups: complete ? panels.groups.map((group) => ({ group_id: group.id, gti_w_m2: Math.round(tiltedIrradiance(row, group, location.latitude, location.longitude) * 10) / 10 })) : null })) };
}
