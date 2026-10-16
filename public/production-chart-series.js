/** Controleert of twee punten verbonden mogen worden; input: punten met optionele tijdvakgrenzen en maximale afstand; output: boolean zonder verbinding over ontbrekende tijdvakken. */
export function canConnectPoints(previous, next, maxGapMs) {
  if (!previous || !next || next.ms - previous.ms > maxGapMs) return false;
  return !Number.isFinite(previous.interval_end_ms) || !Number.isFinite(next.interval_start_ms) || next.interval_start_ms <= previous.interval_end_ms;
}

/** Leest een punt op een getekende rechte lijn zonder meetgaten te overbruggen; input: gesorteerde {ms,value}[]-punten, tijd-ms en maximale afstand tussen punten; output: getal of null. */
export function lineValueAt(points, ms, maxGapMs) {
  if (!Number.isFinite(ms) || !points.length) return null;
  let from = 0, to = points.length;
  while (from < to) {
    const middle = Math.floor((from + to) / 2);
    if (points[middle].ms < ms) from = middle + 1;
    else to = middle;
  }
  const next = points[from];
  if (next?.ms === ms) return next.value;
  const previous = points[from - 1];
  if (!canConnectPoints(previous, next, maxGapMs)) return null;
  return previous.value + (next.value - previous.value) * (ms - previous.ms) / (next.ms - previous.ms);
}

/** Zet voorspeltijdvakken om naar een rechte lijn tussen hun middelpunten, begrensd op daglicht; input: voorspelslots en zonsopkomst/-ondergang in ms; output: geordende punten met tijdvakgrenzen. */
export function forecastLinePoints(slots, start, end) {
  const samples = new Map();
  const valid = [];
  for (const slot of slots) {
    const from = Date.parse(slot.start), to = Date.parse(slot.end);
    if (!Number.isFinite(slot.power_w) || slot.power_w < 0 || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    const ms = (from + to) / 2;
    const point = { ms, value: slot.power_w, interval_start_ms: from, interval_end_ms: to };
    samples.set(ms, point);
    valid.push(point);
  }
  const all = [...samples.values()].sort((a, b) => a.ms - b.ms);
  const points = all.filter((point) => point.ms >= start && point.ms <= end);
  for (const boundary of [start, end]) {
    if (points.some((point) => point.ms === boundary)) continue;
    const value = lineValueAt(all, boundary, 75 * 60000);
    // Het eerste/laatste tijdvak kan nog wel de grens dekken als een buurpunt ontbreekt.
    const covering = valid.find((slot) => slot.interval_start_ms <= boundary && slot.interval_end_ms >= boundary);
    const edge = value ?? covering?.value;
    if (edge !== undefined && edge !== null) points.push({ ...covering, ms: boundary, value: edge });
  }
  return points.sort((a, b) => a.ms - b.ms);
}
