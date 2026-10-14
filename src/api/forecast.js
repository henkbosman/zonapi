import { estimatePv } from '../pv/model.js';
import { tiltedIrradiance } from '../pv/plane-irradiance.js';

/** Vormt opgeslagen weeruren om naar een forecast-API-resultaat; input: rijen, paneelconfig en locatie; output: rijen met PV en kwaliteitsstatus. */
export function forecastResponse(rows, panels, panelErrors, location, now, staleHours) {
  const complete = panelErrors.length === 0 && Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
  const stale = rows.some((row) => now - row.fetched_ms > staleHours * 3600000);
  const slots = rows.map((row) => {
    const result = complete ? estimatePv(row, panels, location.latitude, location.longitude) : null;
    return { start: new Date(row.start_ms).toISOString(), end: new Date(row.end_ms).toISOString(), ghi_w_m2: row.ghi, dni_w_m2: row.dni, dhi_w_m2: row.dhi, source: row.source, fetched_at: new Date(row.fetched_ms).toISOString(), power_w: result?.power_w ?? null, groups: result?.groups ?? null };
  });
  return { status: rows.length ? (complete ? (stale ? 'stale' : 'ok') : 'configuration_incomplete') : 'forecast_unavailable', missing: complete ? [] : panelErrors, resolution_minutes: 60, slots };
}

/** Vormt weeruren om naar instralings-API-resultaat; input: rijen, panelen, fouten en locatie; output: GHI/DNI/DHI en GTI per groep. */
export function irradianceResponse(rows, panels, panelErrors, location) {
  const complete = !panelErrors.length && Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
  return { status: rows.length ? 'ok' : 'forecast_unavailable', slots: rows.map((row) => ({ start: new Date(row.start_ms).toISOString(), end: new Date(row.end_ms).toISOString(), ghi_w_m2: row.ghi, dni_w_m2: row.dni, dhi_w_m2: row.dhi, source: row.source, fetched_at: new Date(row.fetched_ms).toISOString(), groups: complete ? panels.groups.map((group) => ({ group_id: group.id, gti_w_m2: Math.round(tiltedIrradiance(row, group, location.latitude, location.longitude) * 10) / 10 })) : null })) };
}
