const quarterMs = 15 * 60000;
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Bepaalt het Nederlandse klokkwartier; input: epoch-ms; output: minuut van de dag (0,15,...,1425), ook tijdens zomer- en wintertijd. */
export function clockQuarter(ms) {
  const parts = Object.fromEntries(clock.formatToParts(ms).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Math.floor(Number(parts.minute) / 15) * 15;
}

/** Schrijft een kwartiersleutel als kloktijd; input: minuut van de dag; output: HH:mm. */
export function quarterLabel(minute) { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; }

/** Splitst weertijdvakken op kwartiergrenzen met behoud van het oorspronkelijke modelmiddelpunt; input: geordende rijen; output: niet-overlappende kwartierdelen. */
export function splitForecastQuarters(rows) {
  return rows.flatMap((row) => {
    const result = [];
    for (let at = row.start_ms; at < row.end_ms;) {
      const end = Math.min(row.end_ms, (Math.floor(at / quarterMs) + 1) * quarterMs);
      result.push({ ...row, start_ms: at, end_ms: end, sample_start_ms: row.sample_start_ms ?? row.start_ms,
        sample_end_ms: row.sample_end_ms ?? row.end_ms, source_resolution_minutes: row.source_resolution_minutes ?? (row.end_ms - row.start_ms) / 60000 });
      at = end;
    }
    return result;
  });
}
