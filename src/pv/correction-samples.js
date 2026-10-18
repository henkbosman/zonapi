export const FIVE_MINUTES_MS = 300000;
export const CORRECTION_QUARTER_MS = 900000;

/** Verbindt echte meetklokken met nabije vijfminutenmomenten; input: bronrijen, verwachte serienummers, grenzen en peiltijd; output: volledige totalen en gedeeltelijke momentgroepen, zonder hergebruik van een meting. */
export function fiveMinuteSamples(rows, serials, config, now) {
  const allowed = new Set(serials), buckets = new Map(), complete = new Map();
  for (const row of rows) {
    if (!allowed.has(row.serial) || !Number.isFinite(row.power_w) || row.power_w < 0 || !Number.isFinite(row.measured_ms) || row.measured_ms > now) continue;
    if (Number.isFinite(row.received_ms) && row.received_ms > now) continue;
    const slot = Math.round(row.measured_ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const distance = Math.abs(row.measured_ms - slot);
    if (distance > config.sample_tolerance_seconds * 1000) continue;
    if (!buckets.has(slot)) buckets.set(slot, new Map());
    const bucket = buckets.get(slot), previous = bucket.get(row.serial);
    if (!previous || distance < previous.distance || (distance === previous.distance && (row.received_ms ?? 0) >= (previous.row.received_ms ?? 0))) bucket.set(row.serial, { row, distance });
  }
  for (const [time, bucket] of buckets) {
    if (bucket.size !== serials.length) continue;
    const values = serials.map((serial) => bucket.get(serial).row), times = values.map((row) => row.measured_ms);
    if (Math.max(...times) - Math.min(...times) > config.max_skew_seconds * 1000) continue;
    complete.set(time, { time, values, power_w: values.reduce((sum, row) => sum + row.power_w, 0),
      measured_from: Math.min(...times), measured_to: Math.max(...times) });
  }
  return { buckets, complete };
}

/** Herkent hoogstens één duidelijke uitschieter naast twee overeenkomende totalen; input: drie tijdsgeordende metingen en grenzen; output: gebruikte en genegeerde indices. Een brede trend zonder overeenkomend paar blijft intact. */
export function filterCorrectionSamples(samples, config) {
  if (samples.length !== 3) throw new Error('De kwartiercorrectie vereist drie meetmomenten');
  const pairs = [[0, 1], [0, 2], [1, 2]].sort((a, b) => Math.abs(samples[a[0]].power_w - samples[a[1]].power_w) - Math.abs(samples[b[0]].power_w - samples[b[1]].power_w));
  const [a, b] = pairs[0], other = [0, 1, 2].find((index) => index !== a && index !== b);
  const mean = (samples[a].power_w + samples[b].power_w) / 2;
  const threshold = Math.max(config.outlier_min_w, config.outlier_relative * mean);
  const agree = Math.abs(samples[a].power_w - samples[b].power_w) <= threshold / 2;
  const outlier = agree && Math.abs(samples[other].power_w - mean) > threshold;
  return { used: outlier ? [a, b].sort() : [0, 1, 2], ignored: outlier ? [other] : [] };
}
