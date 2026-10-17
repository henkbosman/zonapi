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

/** Zet tijdvakgemiddelden op hun eindtijd, zoals de Open-Meteo-bronklok; input: slots en zonuren in ms; output: punten met expliciete tijdvakken en ongemarkeerde lijnranden. */
export function forecastLinePoints(slots, start, end) {
  const samples = new Map();
  const valid = [];
  for (const slot of slots) {
    const from = Date.parse(slot.start), to = Date.parse(slot.end);
    if (!Number.isFinite(slot.power_w) || slot.power_w < 0 || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    const ms = to;
    const point = { ms, value: slot.power_w, interval_start_ms: from, interval_end_ms: to,
      sample_start_ms: Date.parse(slot.sample_start ?? slot.start), sample_end_ms: Date.parse(slot.sample_end ?? slot.end),
      source_resolution_minutes: slot.source_resolution_minutes ?? (to - from) / 60000 };
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
    if (edge !== undefined && edge !== null) points.push({ ...covering, ms: boundary, value: edge, synthetic: true });
  }
  return points.sort((a, b) => a.ms - b.ms);
}

/** Kiest leesbare kloklabels op vaste kwartier-/uurgrenzen plus de zonranden; input: begin/einde en plotbreedte; output: epoch-ms zonder willekeurige dagfracties. */
export function clockAxisTicks(start, end, width) {
  const count = Math.max(1, Math.floor(width / 90));
  const steps = [15, 30, 60, 120, 180, 240, 360, 720, 1440].map((minutes) => minutes * 60000);
  const step = steps.find((candidate) => (end - start) / candidate <= count) ?? steps.at(-1);
  const edgeGap = (end - start) * 52 / width;
  const ticks = [start];
  for (let at = Math.ceil(start / step) * step; at < end; at += step) {
    if (at - start >= edgeGap && end - at >= edgeGap) ticks.push(at);
  }
  return [...ticks, end];
}
