/** Selecteert nieuwste tijdvakken en bij gelijke ophaaltijd de fijnste resolutie; input: overlappende rijen en zoekgrenzen; output: gesorteerde, niet-overlappende rijen met oorspronkelijke middelpuntinformatie. */
export function forecastTimeline(rows, from, to) {
  const events = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.start_ms) || !Number.isFinite(row.end_ms) || row.end_ms <= row.start_ms) continue;
    for (const [at, kind] of [[row.start_ms, 'start'], [row.end_ms, 'end']]) {
      if (!events.has(at)) events.set(at, { start: [], end: [] });
      events.get(at)[kind].push(row);
    }
  }
  const times = [...events.keys()].sort((a, b) => a - b);
  const active = new Set(), segments = [];
  for (let index = 0; index < times.length - 1; index++) {
    const at = times[index], next = times[index + 1];
    for (const row of events.get(at).end) active.delete(row);
    for (const row of events.get(at).start) active.add(row);
    const chosen = [...active].sort((a, b) => b.fetched_ms - a.fetched_ms || (a.end_ms - a.start_ms) - (b.end_ms - b.start_ms))[0];
    if (!chosen) continue;
    const previous = segments.at(-1);
    if (previous?.row === chosen && previous.end === at) previous.end = next;
    else segments.push({ row: chosen, start: at, end: next });
  }
  return segments.filter((segment) => segment.end > from && segment.start < to).map(({ row, start, end }) => ({
    ...row, start_ms: start, end_ms: end, sample_start_ms: row.start_ms, sample_end_ms: row.end_ms,
    source_resolution_minutes: (row.end_ms - row.start_ms) / 60000
  }));
}

/** Selecteert PV-tijdvakken onafhankelijk per paneelgroep; input: PV-rijen en zoekgrenzen; output: geordende rijen zonder overlap binnen iedere groep. */
export function pvForecastTimeline(rows, from, to) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.group_id)) groups.set(row.group_id, []);
    groups.get(row.group_id).push(row);
  }
  return [...groups.values()].flatMap((group) => forecastTimeline(group, from, to)).sort((a, b) => a.start_ms - b.start_ms || a.group_id.localeCompare(b.group_id));
}
