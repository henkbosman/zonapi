const radians = Math.PI / 180;

/** Berekent declinatie en tijdsvergelijking volgens NOAA; input: UTC epoch ms; output: {declination,equationMinutes}. */
export function solarTerms(atMs) {
  const t = (atMs / 86400000 + 2440587.5 - 2451545) / 36525;
  const meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const anomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const correction = Math.sin(anomaly * radians) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * anomaly * radians) * (0.019993 - 0.000101 * t) + Math.sin(3 * anomaly * radians) * 0.000289;
  const apparentLongitude = meanLongitude + correction - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * radians);
  const obliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - 0.001813 * t))) / 60) / 60 + 0.00256 * Math.cos((125.04 - 1934.136 * t) * radians);
  const declination = Math.asin(Math.sin(obliquity * radians) * Math.sin(apparentLongitude * radians));
  const y = Math.tan(obliquity * radians / 2) ** 2;
  const equationMinutes = 4 / radians * (y * Math.sin(2 * meanLongitude * radians) - 2 * eccentricity * Math.sin(anomaly * radians) + 4 * eccentricity * y * Math.sin(anomaly * radians) * Math.cos(2 * meanLongitude * radians) - 0.5 * y * y * Math.sin(4 * meanLongitude * radians) - 1.25 * eccentricity ** 2 * Math.sin(2 * anomaly * radians));
  return { declination, equationMinutes };
}

/** Berekent zonnestand op een locatie; input: UTC ms, breedte- en lengtegraad; output: {zenith_deg,azimuth_deg}. */
export function solarPosition(atMs, latitude, longitude) {
  const { declination, equationMinutes } = solarTerms(atMs);
  const utc = new Date(atMs);
  const utcMinutes = utc.getUTCHours() * 60 + utc.getUTCMinutes() + utc.getUTCSeconds() / 60;
  const hourAngle = ((utcMinutes + equationMinutes + 4 * longitude) / 4 - 180) * radians;
  const lat = latitude * radians;
  const cosZenith = Math.max(-1, Math.min(1, Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)));
  const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat)) / radians + 180 + 360) % 360;
  return { zenith_deg: Math.acos(cosZenith) / radians, azimuth_deg: azimuth };
}

/** Benadert zonsopkomst en zonsondergang zonder netwerk; input: lokale datum YYYY-MM-DD, coördinaten; output: {sunrise_ms,sunset_ms} of null. */
export function offlineSunTimes(day, latitude, longitude) {
  const [year, month, date] = day.split('-').map(Number);
  const midnightUtc = Date.UTC(year, month - 1, date);
  const { declination, equationMinutes } = solarTerms(midnightUtc + 12 * 3600000);
  const lat = latitude * radians;
  const cosHourAngle = (Math.cos(90.833 * radians) - Math.sin(lat) * Math.sin(declination)) / (Math.cos(lat) * Math.cos(declination));
  if (cosHourAngle < -1 || cosHourAngle > 1) return null;
  const noonMinutes = 720 - 4 * longitude - equationMinutes;
  const deltaMinutes = 4 * Math.acos(cosHourAngle) / radians;
  return { sunrise_ms: Math.round(midnightUtc + (noonMinutes - deltaMinutes) * 60000), sunset_ms: Math.round(midnightUtc + (noonMinutes + deltaMinutes) * 60000) };
}
