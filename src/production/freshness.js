/** Bepaalt de maximale meetleeftijd per bron; input: ingestelde minuten en bron; output: minuten, met behoud van de marge voor vertraagd aangeleverde cloudmetingen. */
export function productionFreshnessMinutes(minutes, source) {
  return source === 'cloud' ? Math.max(minutes, 20) : minutes;
}
