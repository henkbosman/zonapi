import { estimatePv } from '../pv/model.js';
import { tiltedIrradiance } from '../pv/plane-irradiance.js';
import { forecastResolution } from '../weather/resolution.js';

/** Vormt weertijdvakken om naar een voorspelling; input: rijen, panelen, fouten, locatie, tijd, versheid, kalibratie en optioneel correctiemodel; output: basis en gecorrigeerde PV met bronmetadata en kwaliteitsstatus. */
export function forecastResponse(rows, panels, panelErrors, location, now, staleHours, calibrationFactor = 1, model = null) {
  const complete = panelErrors.length === 0 && Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
  const stale = rows.some((row) => now - row.fetched_ms > staleHours * 3600000);
  const prepared = model ? model.prepare(rows) : rows;
  const slots = prepared.map((row) => {
    const result = complete ? model ? model.estimate(row) : estimatePv(row, panels, location.latitude, location.longitude, calibrationFactor) : null;
    return { ...slotMetadata(row), ghi_w_m2: row.ghi, dni_w_m2: row.dni, dhi_w_m2: row.dhi, power_w: result?.power_w ?? null,
      base_power_w: result?.base_power_w ?? result?.power_w ?? null, automatic_correction_factor: result?.correction_factor ?? 1,
      correction_source: result?.correction_source ?? 'none', correction_reference_start: result?.correction_reference_start ?? null,
      correction_reference_end: result?.correction_reference_end ?? null, groups: result?.groups ?? null };
  });
  const status = model?.status();
  if (status) delete status.quarters;
  return { status: rows.length ? (complete ? (stale ? 'stale' : 'ok') : 'configuration_incomplete') : 'forecast_unavailable', missing: complete ? [] : panelErrors,
    calibration_factor: calibrationFactor, ...(status ? { automatic_correction: status } : {}), ...forecastResolution(prepared), slots };
}

/** Beschrijft één effectief voorspeltijdvak; input: opgeslagen rij; output: einde als bronklok, gemiddeldebetekenis, ISO-grenzen en bronresolutie. */
export function slotMetadata(row) {
  return { start: new Date(row.start_ms).toISOString(), end: new Date(row.end_ms).toISOString(), time: new Date(row.end_ms).toISOString(),
    time_basis: 'preceding_interval_mean', sample_start: new Date(row.sample_start_ms ?? row.start_ms).toISOString(), sample_end: new Date(row.sample_end_ms ?? row.end_ms).toISOString(),
    source: row.source, model: row.model ?? null, fetched_at: new Date(row.fetched_ms).toISOString(),
    resolution_minutes: (row.end_ms - row.start_ms) / 60000,
    source_resolution_minutes: row.source_resolution_minutes ?? (row.end_ms - row.start_ms) / 60000 };
}

/** Vormt weertijdvakken om naar instralings-API-resultaat; input: rijen, panelen, fouten en locatie; output: GHI/DNI/DHI, resoluties en GTI per groep. */
export function irradianceResponse(rows, panels, panelErrors, location) {
  const complete = !panelErrors.length && Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
  return { status: rows.length ? 'ok' : 'forecast_unavailable', ...forecastResolution(rows), slots: rows.map((row) => ({ ...slotMetadata(row), ghi_w_m2: row.ghi, dni_w_m2: row.dni, dhi_w_m2: row.dhi, groups: complete ? panels.groups.map((group) => ({ group_id: group.id, gti_w_m2: Math.round(tiltedIrradiance(row, group, location.latitude, location.longitude) * 10) / 10 })) : null })) };
}
