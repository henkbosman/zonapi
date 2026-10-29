import { automaticCorrectionConfig } from './automatic-config.js';
import { learnPvCorrection } from './learn-correction.js';
import { fiveMinuteSamples, filterCorrectionSamples, FIVE_MINUTES_MS, CORRECTION_QUARTER_MS } from './correction-samples.js';
import { productionHistory } from '../production/source.js';
import { productionFreshnessMinutes } from '../production/freshness.js';

const iso = (ms) => new Date(ms).toISOString();

/** Bereidt een Open-Meteo-kwartier voor uit drie volledige Growatt-totalen op t-5/t/t+5; input: opslag, model, fouten, bronrijen, ontvangsttijd en optionele rekenmodus; output: wachtstatus en gebruikte/gefilterde metingen. De productiedienst toetst na de meetdag het eigen bewolkingspunt. */
export function learnQuarterCorrection(repository, settings, panels, panelErrors, rows, now, { defer = true } = {}) {
  const config = automaticCorrectionConfig(settings);
  if (!config.enabled) return { status: 'disabled' };
  if (panelErrors.length || !Number.isFinite(settings.location.latitude) || !Number.isFinite(settings.location.longitude)) return { status: 'configuration_incomplete' };
  const known = panels.inverters.map((item) => item.serial).filter(Boolean);
  const selected = new Map(rows.filter((row) => !known.length || known.includes(row.serial)).map((row) => [row.serial, row]));
  if (selected.size !== settings.growatt.expected_inverters) return { status: 'incomplete', received_inverters: selected.size, expected_inverters: settings.growatt.expected_inverters };
  const latest = [...selected.values()];
  const source = settings.growatt.production_source === 'cloud' ? 'cloud' : 'shinelink';
  if (latest.some((row) => !Number.isFinite(row.power_w) || row.power_w < 0 || !Number.isFinite(row.measured_ms) || row.measured_ms > now || now - row.measured_ms > productionFreshnessMinutes(settings.growatt.fresh_minutes, row.source ?? source) * 60000)) return { status: 'stale' };
  const serials = known.length ? known : [...selected.keys()];
  const history = productionHistory(repository, settings, now - 3600000, now + 1);
  const { buckets, complete, diagnostics } = fiveMinuteSamples([...history, ...latest.map((row) => ({ ...row, source: row.source ?? source }))], serials, config, now);
  const latestSlot = buckets.size ? Math.max(...buckets.keys()) : Math.round(Math.max(...latest.map((row) => row.measured_ms)) / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const pendingTarget = Math.floor((latestSlot + FIVE_MINUTES_MS) / CORRECTION_QUARTER_MS) * CORRECTION_QUARTER_MS;
  const required = [-1, 0, 1].map((offset) => pendingTarget + offset * FIVE_MINUTES_MS);
  const pending = { target_time: iso(pendingTarget), required_times: required.map(iso),
    missing_times: required.filter((time) => !complete.has(time)).map(iso), received_samples: required.filter((time) => complete.has(time)).length,
    moments: required.map((time) => ({ time: iso(time), received_inverters: buckets.get(time)?.size ?? 0, expected_inverters: serials.length,
      complete: complete.has(time) })), sample_tolerance_seconds: config.sample_tolerance_seconds, diagnostics };
  const targets = [...complete.keys()].filter((time) => time % CORRECTION_QUARTER_MS === 0 && time + FIVE_MINUTES_MS <= now
    && complete.has(time - FIVE_MINUTES_MS) && complete.has(time + FIVE_MINUTES_MS)).sort((a, b) => b - a);
  if (!targets.length) return { status: 'waiting_for_samples', ...pending };
  const target = targets[0], samples = [-1, 0, 1].map((offset) => complete.get(target + offset * FIVE_MINUTES_MS));
  const filtered = filterCorrectionSamples(samples, config);
  const values = serials.map((serial, index) => ({ serial,
    power_w: filtered.used.reduce((sum, sample) => sum + samples[sample].values[index].power_w, 0) / filtered.used.length,
    measured_ms: Math.max(...samples.map((sample) => sample.values[index].measured_ms)),
    received_ms: Math.max(...samples.map((sample) => sample.values[index].received_ms ?? now)), source: samples.at(-1).values[index].source ?? source }));
  const sampling = { method: 'three_point_mean', target_time: iso(target), used_samples: filtered.used.length, total_samples: 3,
    ignored_times: filtered.ignored.map((index) => iso(samples[index].time)), sample_tolerance_seconds: config.sample_tolerance_seconds,
    outlier_relative: config.outlier_relative, outlier_min_w: config.outlier_min_w,
    samples: samples.map((sample, index) => ({ time: iso(sample.time), power_w: sample.power_w, used: filtered.used.includes(index),
      measured_from: iso(sample.measured_from), measured_to: iso(sample.measured_to),
      inverters: sample.values.map((row) => ({ serial: row.serial, measured_at: iso(row.measured_ms), power_w: row.power_w, source: row.source ?? source })) })) };
  const result = learnPvCorrection(repository, settings, panels, panelErrors, values, now, { target_ms: target, sampling, defer });
  return { ...result, target_time: iso(target), sampling, ...(pendingTarget > target ? { pending } : {}) };
}
