import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getCalibrationFactor } from '../pv/calibration.js';
import { getWeatherResolution } from '../weather/resolution.js';
import { growattCloudConfig } from '../growatt/cloud/config.js';
import { automaticCorrectionConfig } from '../pv/automatic-config.js';
import { getWeatherPollMinutes } from '../weather/poll-interval.js';

export const root = resolve(import.meta.dirname, '../..');

/** Leest een JSON-configuratie; input: pad vanaf projectroot; output: geparseerd object of fout. */
export function readConfig(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

/** Valideert configuratiegrenzen; input: instellingenobject; output: lijst met fouten. */
export function validateSettings(config) {
  const errors = [];
  try { getCalibrationFactor(config); } catch (error) { errors.push(error.message); }
  try { automaticCorrectionConfig(config); } catch (error) { errors.push(error.message); }
  try { getWeatherResolution(config); } catch (error) { errors.push(error.message); }
  try { getWeatherPollMinutes(config); } catch (error) { errors.push(error.message); }
  try { growattCloudConfig(config); } catch (error) { errors.push(error.message); }
  if (config.timezone !== 'Europe/Amsterdam') errors.push('timezone moet Europe/Amsterdam zijn');
  for (const [name, item] of [['http', config.http], ['growatt', config.growatt]]) {
    if (!item || typeof item.host !== 'string' || !Number.isInteger(item.port) || item.port < 0 || item.port > 65535) errors.push(`${name}.host/port ongeldig`);
  }
  if (!Number.isInteger(config.weather?.forecast_days) || config.weather.forecast_days < 2 || config.weather.forecast_days > 16) errors.push('weather.forecast_days moet 2..16 zijn');
  if (!(config.weather?.retry_minutes >= 5 && config.weather.retry_minutes <= 1440)) errors.push('weather.retry_minutes moet 5..1440 zijn');
  if (!(config.weather?.stale_after_hours > 0 && config.weather.stale_after_hours <= 72)) errors.push('weather.stale_after_hours moet 0..72 zijn');
  if (config.weather?.source !== 'open-meteo') errors.push('onbekende weather.source: voeg eerst een adapter toe');
  if (!Number.isInteger(config.advice?.search_hours) || config.advice.search_hours < 1 || config.advice.search_hours > 168) errors.push('advice.search_hours moet 1..168 zijn');
  if (!Number.isInteger(config.advice?.start_step_minutes) || config.advice.start_step_minutes < 1 || config.advice.start_step_minutes > 60) errors.push('advice.start_step_minutes moet 1..60 zijn');
  if (typeof config.advice?.min_solar_share !== 'number' || config.advice.min_solar_share < 0 || config.advice.min_solar_share > 1) errors.push('advice.min_solar_share moet 0..1 zijn');
  if (!(config.advice?.reserve_w >= 0 && config.advice.reserve_w < 20000)) errors.push('advice.reserve_w moet >=0 zijn');
  if (!Number.isInteger(config.advice?.history_days) || config.advice.history_days < 1 || config.advice.history_days > 90) errors.push('advice.history_days moet 1..90 zijn');
  if (config.advice?.baseload_w !== null && (!Number.isFinite(config.advice?.baseload_w) || config.advice.baseload_w < 0)) errors.push('advice.baseload_w moet null of >=0 zijn');
  if (!Number.isInteger(config.growatt?.expected_inverters) || config.growatt.expected_inverters < 1) errors.push('growatt.expected_inverters ongeldig');
  if (config.growatt?.overview_group_seconds !== undefined && (!Number.isInteger(config.growatt.overview_group_seconds) || config.growatt.overview_group_seconds < 1 || config.growatt.overview_group_seconds > 86400)) errors.push('growatt.overview_group_seconds moet 1..86400 zijn');
  if (!Number.isInteger(config.growatt?.idle_timeout_minutes ?? 30) || (config.growatt?.idle_timeout_minutes ?? 30) < 1 || (config.growatt?.idle_timeout_minutes ?? 30) > 120) errors.push('growatt.idle_timeout_minutes moet 1..120 zijn');
  if (config.growatt?.time_sync_on_announcement !== undefined && typeof config.growatt.time_sync_on_announcement !== 'boolean') errors.push('growatt.time_sync_on_announcement moet true of false zijn');
  if (!Number.isInteger(config.growatt?.time_sync_retry_minutes ?? 10) || (config.growatt?.time_sync_retry_minutes ?? 10) < 1 || (config.growatt?.time_sync_retry_minutes ?? 10) > 120) errors.push('growatt.time_sync_retry_minutes moet 1..120 zijn');
  if (!(config.growatt?.fresh_minutes >= 1 && config.growatt.fresh_minutes <= 120)) errors.push('growatt.fresh_minutes moet 1..120 zijn');
  if (!Array.isArray(config.homewizard?.net_meter_priority) || config.homewizard.net_meter_priority.length !== 2 || new Set(config.homewizard.net_meter_priority).size !== 2 || !config.homewizard.net_meter_priority.every((item) => ['p1', 'kwh'].includes(item))) errors.push('homewizard.net_meter_priority moet p1 en kwh bevatten');
  if (config.homewizard?.connection_phases !== 1 || config.homewizard?.same_net_point !== true) errors.push('meterconfiguratie moet overeenkomen met de bevestigde eenfasige, gedeelde netmeting');
  if (!Number.isInteger(config.homewizard?.poll_seconds) || config.homewizard.poll_seconds < 5) errors.push('homewizard.poll_seconds moet minimaal 5 zijn');
  for (const device of ['p1', 'kwh']) {
    if (typeof config.homewizard?.[device]?.host !== 'string' || !['v1', 'v2'].includes(config.homewizard[device].api)) errors.push(`homewizard.${device}.host/api ongeldig`);
  }
  return errors;
}

/** Controleert paneelgroepen; input: panelenconfiguratie; output: lijst met ontbrekende/ongeldige velden. */
export function validatePanels(panels) {
  const errors = [];
  const inverters = new Set((panels.inverters ?? []).map((item) => item.id));
  const serials = (panels.inverters ?? []).map((item) => item.serial).filter(Boolean);
  if (inverters.size !== panels.inverters?.length || !inverters.size) errors.push('configureer unieke inverters');
  if (new Set(serials).size !== serials.length || serials.some((item) => !/^[A-Z0-9]{10}$/.test(item))) errors.push('omvormerserienummers moeten uniek zijn en 10 letters/cijfers bevatten');
  const ids = new Set();
  let count = 0;
  for (const group of panels.groups ?? []) {
    if (!group.id || ids.has(group.id)) errors.push('paneelgroepen moeten unieke ids hebben');
    ids.add(group.id);
    if (!Number.isInteger(group.count) || group.count < 1) errors.push(`${group.id}: count moet positief zijn`);
    else count += group.count;
    if (!inverters.has(group.inverter_id)) errors.push(`${group.id}: kies inverter_id`);
    if (!(group.wp_per_panel > 0)) errors.push(`${group.id}: vul wp_per_panel in`);
    if (typeof group.tilt_deg !== 'number' || !(group.tilt_deg >= 0 && group.tilt_deg <= 90)) errors.push(`${group.id}: vul tilt_deg (0..90) in`);
    if (!(group.azimuth_deg >= 0 && group.azimuth_deg < 360)) errors.push(`${group.id}: azimuth_deg (0..359) ongeldig`);
    if (!(group.loss_factor > 0 && group.loss_factor <= 1)) errors.push(`${group.id}: loss_factor (0..1) ongeldig`);
  }
  if (count !== panels.expected_panel_count) errors.push(`totaal panelen moet ${panels.expected_panel_count} zijn; is ${count}`);
  for (const item of panels.inverters ?? []) {
    if (!(item.ac_limit_w > 0)) errors.push(`${item.id}: ac_limit_w ongeldig`);
  }
  return errors;
}

/** Leest instellingen en panelen; input: geen; output: {settings, panels, panel_errors} of fout bij ongeldige instellingen. */
export function loadConfiguration() {
  const settings = readConfig('config/settings.json');
  const panels = readConfig('config/panels.json');
  const errors = validateSettings(settings);
  if (errors.length) throw new Error(`Configuratie ongeldig: ${errors.join('; ')}`);
  settings.weather.poll_minutes = getWeatherPollMinutes(settings);
  settings.weather.forecast_days = Math.max(3, settings.weather.forecast_days);
  const panel_errors = validatePanels(panels);
  if (panels.inverters.length !== settings.growatt.expected_inverters) panel_errors.push(`configureer precies ${settings.growatt.expected_inverters} omvormers`);
  return { settings, panels, panel_errors };
}
