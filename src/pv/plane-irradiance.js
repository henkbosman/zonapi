import { solarPosition } from '../weather/solar-position.js';

/** Rekent horizontale instraling om naar paneelvlak (isotrope diffuse hemel); input: weertijdvak, paneelgroep, locatie; output: GTI W/m². */
export function tiltedIrradiance(row, group, latitude, longitude) {
  const midpoint = ((row.sample_start_ms ?? row.start_ms) + (row.sample_end_ms ?? row.end_ms)) / 2;
  const sun = solarPosition(midpoint, latitude, longitude);
  const rad = Math.PI / 180;
  const beta = group.tilt_deg * rad;
  const zenith = sun.zenith_deg * rad;
  const azimuthDifference = (sun.azimuth_deg - group.azimuth_deg) * rad;
  const incidence = Math.max(0, Math.cos(zenith) * Math.cos(beta) + Math.sin(zenith) * Math.sin(beta) * Math.cos(azimuthDifference));
  const direct = sun.zenith_deg >= 90 ? 0 : row.dni * incidence;
  const diffuse = row.dhi * (1 + Math.cos(beta)) / 2;
  const ground = row.ghi * 0.2 * (1 - Math.cos(beta)) / 2;
  return Math.max(0, direct + diffuse + ground);
}
