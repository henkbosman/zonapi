const cloudyCodes = new Set([3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99]);

/** Groepeert de oorspronkelijke Open-Meteo-weercode voor de drie grafiekiconen; input: WMO-code; output: clear, partly_cloudy, cloudy of unknown. Dit verandert de strengere correctiecontrole niet. */
export function skyAppearance(code) {
  if (code === 0) return 'clear';
  if (code === 1 || code === 2) return 'partly_cloudy';
  return cloudyCodes.has(code) ? 'cloudy' : 'unknown';
}
