import { createHash } from 'node:crypto';
import { getCalibrationFactor } from './calibration.js';

/** Identificeert het paneelmodel voor een eigen leerpatroon; input: instellingen en panelen; output: SHA-256, onafhankelijk van object- en lijstvolgorde. */
export function correctionModelKey(settings, panels) {
  const inverters = panels.inverters.map(({ id, serial, ac_limit_w }) => ({ id, serial: serial ?? '', ac_limit_w })).sort((a, b) => a.id.localeCompare(b.id));
  const groups = panels.groups.map(({ id, inverter_id, count, wp_per_panel, tilt_deg, azimuth_deg, loss_factor }) =>
    ({ id, inverter_id, count, wp_per_panel, tilt_deg, azimuth_deg, loss_factor })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify({ version: 1, source: settings.weather.source, location: { latitude: settings.location.latitude, longitude: settings.location.longitude }, timezone: settings.timezone,
    calibration_factor: getCalibrationFactor(settings), inverters, groups })).digest('hex');
}
