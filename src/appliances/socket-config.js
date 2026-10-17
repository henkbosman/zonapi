import { createHash } from 'node:crypto';
import { checkHost } from '../homewizard/client.js';

/** Leest de optionele Energy Socket en herkenningsgrenzen; input: apparaatprofiel; output: configuratie of null zonder ingestelde host. */
export function socketConfig(profile) {
  const value = profile.homewizard;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('homewizard moet een object zijn');
  if (typeof value.host !== 'string') throw new Error('homewizard.host moet een IP-adres of DNS-naam zijn');
  if (value.api !== undefined && value.api !== 'v1') throw new Error('Energy Sockets gebruiken homewizard.api v1');
  const config = { host: value.host.trim(), api: 'v1', start_threshold_w: value.start_threshold_w ?? 10,
    stop_threshold_w: value.stop_threshold_w ?? 5, start_delay_seconds: value.start_delay_seconds ?? 30,
    stop_delay_seconds: value.stop_delay_seconds ?? 300 };
  if (config.host) checkHost(config.host);
  if (!Number.isFinite(config.start_threshold_w) || config.start_threshold_w <= 0 || config.start_threshold_w > 10000) throw new Error('homewizard.start_threshold_w moet >0 en <=10000 zijn');
  if (!Number.isFinite(config.stop_threshold_w) || config.stop_threshold_w < 0 || config.stop_threshold_w >= config.start_threshold_w) throw new Error('homewizard.stop_threshold_w moet >=0 en lager dan start_threshold_w zijn');
  for (const key of ['start_delay_seconds', 'stop_delay_seconds']) {
    if (!Number.isInteger(config[key]) || config[key] < 0 || config[key] > 3600) throw new Error(`homewizard.${key} moet 0..3600 zijn`);
  }
  return config.host ? config : null;
}

/** Koppelt bewaarde herkenning aan exact dezelfde socket en grenzen; input: socketconfiguratie; output: SHA256-sleutel. */
export function socketConfigKey(config) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }

/** Begrensde geldigheid van lokale socketmetingen; input: pollinterval in seconden; output: maximale meetleeftijd in ms. */
export function socketFreshnessMs(pollSeconds) { return Math.max(120000, pollSeconds * 3000); }
