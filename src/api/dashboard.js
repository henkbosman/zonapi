import { loadProfiles } from '../appliances/load-profiles.js';
import { socketActivity } from '../appliances/socket-activity.js';
import { dailyAdvice } from '../appliances/daily-advice.js';
import { getBaseload } from '../appliances/baseload.js';
import { createPvForecastModel } from '../pv/forecast-model.js';
import { currentProductionRows } from '../production/source.js';
import { productionResponse, metersResponse } from './measurements.js';
import { productionDayResponse } from './production-day.js';
import { forecastDaysResponse } from './forecast-days.js';
import { applianceCycleResponse } from './appliance-cycles.js';
import { appliancePrograms, minimumSolarShare } from '../appliances/programs.js';

/** Selecteert uitsluitend afgesproken openbare velden; input: object en veldnamen; output: nieuw object zonder onverwachte bronvelden. */
function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]));
}

/** Verbergt de technische oorzaak van een socketfout; input: interne apparaatstatus; output: alleen status, vermogen en tijden voor het dashboard. */
function publicActivity(value) {
  return { ...pick(value, ['configured', 'state', 'running', 'power_w', 'measured_at', 'started_at', 'stopped_at']),
    error: value?.error ? 'Geen actuele socketmeting beschikbaar' : null };
}

/** Behoudt alleen de zichtbare venstercontrole zonder bronlocatie of interne kandidaatgegevens; input: interne hemelcontrole; output: openbare onderbouwing. */
function publicClearSky(value) {
  return pick(value, ['status', 'window_start', 'window_end', 'checked_from', 'checked_until', 'ready_at', 'uses_forecast',
    'required_samples', 'checked_samples', 'resolution_minutes', 'max_cloud_cover_percent', 'max_allowed_cloud_cover_percent']);
}

/** Behoudt de zichtbare kwartiercorrectie en meetonderbouwing zonder modelhash, omvormers of foutdetails; input: interne correctiestatus; output: openbare correctiestatus. */
function publicCorrection(value) {
  if (!value) return null;
  const sampling = value.latest?.sampling;
  const attempt = value.last_attempt;
  return { ...pick(value, ['enabled', 'status', 'learned_blocks_today', 'learned_quarters', 'total_blocks_in_day']),
    latest: value.latest ? { ...pick(value.latest, ['date', 'start', 'end', 'factor', 'correction_percent']),
      sampling: Number.isFinite(sampling?.used_samples) ? { used_samples: sampling.used_samples,
        ignored_times: sampling.ignored_times ?? [], samples: (sampling.samples ?? []).map((row) => pick(row, ['time', 'power_w', 'used'])),
        ...(sampling.clear_sky ? { clear_sky: publicClearSky(sampling.clear_sky) } : {}) } : null } : null,
    last_attempt: attempt ? { ...pick(attempt, ['status', 'attempted_at', 'target_time', 'ready_at', 'received_samples', 'received_inverters', 'expected_inverters']),
      moments: (attempt.moments ?? []).map((row) => pick(row, ['time', 'received_inverters', 'expected_inverters', 'complete'])),
      diagnostics: pick(attempt.diagnostics, ['rejected_timing', 'rejected_skew']),
      ...(attempt.clear_sky ? { clear_sky: publicClearSky(attempt.clear_sky) } : {}) } : null };
}

/** Geeft alleen de tijdreeksen voor de daggrafiek door; input: interne dagvoorspelling; output: grafiekwaarden zonder paneelgroepen of diagnostiek. */
function publicForecast(value) {
  return { ...pick(value, ['date', 'status', 'sunrise', 'sunset', 'now']), automatic_correction: publicCorrection(value.automatic_correction),
    conditions: { ...pick(value.conditions, ['resolution_minutes', 'time_basis']),
      rows: (value.conditions?.rows ?? []).map((row) => pick(row, ['time', 'cloud_cover_percent', 'weather_code', 'condition', 'weather_model', 'fetched_at', 'stale'])) },
    slots: value.slots.map((row) => pick(row, ['start', 'end', 'time', 'sample_start', 'sample_end', 'resolution_minutes', 'source_resolution_minutes',
      'ghi_w_m2', 'power_w', 'base_power_w', 'automatic_correction_factor', 'correction_source', 'correction_reference_start', 'correction_reference_end',
      'correction_reference_predicted_w', 'correction_reference_measured_w', 'correction_computed_at'])) };
}

/** Selecteert de zichtbare start-/energiegegevens van een cyclus; input: berekend kandidaatadvies; output: openbaar kandidaatadvies of null. */
function publicStart(value) { return value ? pick(value, ['start', 'solar_share', 'solar_share_percent', 'energy_wh', 'solar_wh', 'program_id', 'program_name', 'duration_minutes']) : null; }

/** Laat per programma uitsluitend namen en berekende adviezen door; input: intern apparaat-/programma-advies; output: openbare adviesvelden zonder steps of configuratie. */
function publicProgramAdvice(value) {
  return { ...pick(value, ['id', 'name', 'duration_minutes', 'status', 'can_start_now', 'earliest_start', 'best_start',
    'program_id', 'program_name', 'best_program_id', 'best_program_name', 'minimum_solar_share_percent', 'minimum_solar_share_source']),
    earliest: publicStart(value.earliest), best: publicStart(value.best),
    ...(value.programs ? { programs: value.programs.map(publicProgramAdvice) } : {}) };
}

/** Laat uitsluitend dagadviezen en namen van meegerekende apparaten door; input: interne dagplanning; output: openbare planning zonder configuratie en foutmeldingen. */
function publicAdvice(value) {
  return { generated_at: value.generated_at,
    active_appliances: value.active_appliances.map((row) => pick(row, ['id', 'name', 'fresh', 'remaining_minutes', 'overrun'])),
    days: value.days.map((day) => ({ ...pick(day, ['date', 'sunrise', 'sunset']), appliances: day.appliances.map(publicProgramAdvice) })) };
}

/** Selecteert een gemeten cyclus zonder interne database-id; input: cyclus; output: vermogensverloop of null. */
function publicRun(value) {
  return value ? { ...pick(value, ['state', 'complete', 'started_at', 'ended_at', 'duration_seconds', 'max_gap_seconds', 'energy_split_method']),
    points: value.points.map((row) => pick(row, ['elapsed_seconds', 'power_w', 'solar_power_w', 'grid_power_w'])) } : null;
}

/** Bouwt één alleen-lezen dashboardsnapshot met expliciet toegestane velden; input: dienstafhankelijkheden, profielmap en peiltijd; output: alle zichtbare grafieken en adviezen zonder intern beheer of apparaatadressen. */
export function dashboardResponse({ settings, panels, panelErrors, repository, weather, profilesDirectory }, now) {
  const sunlight = weather.status();
  const serials = panels.inverters.map((item) => item.serial);
  const baseload = getBaseload(settings, repository, now, serials);
  const pv = productionResponse(currentProductionRows(repository, settings, now), settings.growatt.expected_inverters, settings.growatt.fresh_minutes, now, serials);
  const meters = metersResponse(repository.currentMeters(), now, settings.homewizard.net_meter_priority);
  const profiles = [...loadProfiles(profilesDirectory).profiles.values()];
  const forecasts = forecastDaysResponse(repository, settings, panels, panelErrors, sunlight, now);
  const production = productionDayResponse(repository, settings, panels, sunlight, now);
  const model = createPvForecastModel(repository, settings, panels, now);
  const rows = model.prepare(repository.forecast(now, now + (settings.weather.forecast_days + 1) * 24 * 3600000));
  const daily = dailyAdvice(profiles, rows, { settings, panels, panelErrors, pvModel: model, now, baseload,
    latitude: settings.location.latitude, longitude: settings.location.longitude }, repository);
  return { generated_at: new Date(now).toISOString(),
    status: { time: new Date(now).toISOString(),
      weather: pick(sunlight, ['source', 'sunrise', 'sunset', 'used_requests', 'poll_minutes', 'next_fetch']),
      growatt: pick(pv, ['status', 'source', 'expected_inverters', 'active_inverters', 'power_w']),
      homewizard: { net_power_w: meters.net_power_w }, baseload: baseload ? { power_w: baseload.power_w } : null },
    forecasts: { generated_at: forecasts.generated_at, days: forecasts.days.map(publicForecast) },
    profiles: { profiles: profiles.map((profile) => {
      const minimum = minimumSolarShare(profile, settings);
      return { ...pick(profile, ['id', 'name', 'duration_minutes']), minimum_solar_share_percent: minimum.percent,
        minimum_solar_share_source: minimum.source, programs: appliancePrograms(profile).map((program) => pick(program, ['id', 'name', 'duration_minutes'])),
        activity: publicActivity(socketActivity(profile, repository, settings.homewizard.poll_seconds, now)) };
    }) },
    production: { ...pick(production, ['sunrise', 'sunset', 'now']), points: production.points.map((row) =>
      pick(row, ['time', 'power_w', 'measured_from', 'active_inverters', 'expected_inverters'])) },
    daily: publicAdvice(daily),
    cycles: { generated_at: new Date(now).toISOString(), appliances: profiles.map((profile) => {
      const value = applianceCycleResponse(profile, repository, settings, now, panels);
      return { ...pick(value, ['id', 'name', 'configured', 'live', 'elapsed_seconds', 'fresh_seconds']),
        activity: publicActivity(value.activity), current: publicRun(value.current), previous: publicRun(value.previous) };
    }) } };
}
