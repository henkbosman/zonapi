/** Controleert of uurvakken een heel zoekvenster dekken; input: gesorteerde weerrijen en begin/eind-ms; output: boolean. */
export function coversForecastWindow(weather, from, to) {
  let cursor = from;
  for (const row of weather) {
    if (row.end_ms <= cursor) continue;
    if (row.start_ms > cursor) return false;
    cursor = Math.max(cursor, row.end_ms);
    if (cursor >= to) return true;
  }
  return cursor >= to;
}
