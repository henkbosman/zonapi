/** Groepeert de echte bewolkingsfractie voor de grafiek; input: cloud_cover in procent; output: clear bij 0%, partly_cloudy onder 80%, cloudy vanaf 80%, of unknown. De algemene weercode is geen bewolkingspercentage. */
export function skyAppearance(cloudCover) {
  if (!Number.isFinite(cloudCover) || cloudCover < 0 || cloudCover > 100) return 'unknown';
  if (cloudCover === 0) return 'clear';
  return cloudCover < 80 ? 'partly_cloudy' : 'cloudy';
}
