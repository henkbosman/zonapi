import { createHash } from 'node:crypto';
import { growattCloudConfig, growattCloudToken } from './config.js';
import { createGrowattCloudClient } from './client.js';
import { redactCloud } from './redact.js';
import { localDay } from '../../weather/local-day.js';
import { offlineSunTimes } from '../../weather/solar-position.js';

/** Maakt de periodieke Growatt-webbron; input: instellingen, paneelconfig, repository en optionele klok/omgeving/client; output: {poll,start,stop,status} met persistent interval en foutterugval. */
export function createGrowattCloudPoller({ settings, panels, repository, clock = () => Date.now(), environment = process.env, client }) {
  const config = growattCloudConfig(settings);
  const token = growattCloudToken(config, environment);
  const configured = panels.inverters.map((item) => item.serial).filter(Boolean).map((serial) => ({ serial, device_type: config.device_type }));
  const fingerprint = createHash('sha256').update(JSON.stringify([config.base_url, config.plant_id, config.device_type, token, configured])).digest('hex');
  let state = repository.diagnosticState('growatt', 'cloud') ?? {};
  if (state.fingerprint !== fingerprint) state = { fingerprint, failures: 0 };
  let timer = null, pending = null, controller = null, stopping = false;
  const api = client ?? createGrowattCloudClient(config, token, { clock, onCall: repository.saveGrowattCloudCall });

  /** Leest zontijden uit lokale opslag of berekening; input: lokale dag; output: zonuren of null. */
  function sunTimes(day) {
    const { latitude, longitude } = settings.location;
    return repository.getSun(day) ?? (Number.isFinite(latitude) && Number.isFinite(longitude) ? offlineSunTimes(day, latitude, longitude) : null);
  }

  /** Bewaart actuele webbronstatus los van de logschakelaar; input: geen; output: void. */
  function persist() { repository.saveDiagnosticState('growatt', 'cloud', state); }

  /** Bepaalt de te lezen omvormers en bewaart herkenning per account; input: afbreeksignaal; output: serial/type-lijst of fout met beschikbare installaties in status. */
  async function devices(signal) {
    if (configured.length) return configured;
    if (state.devices?.length && clock() - state.discovered_ms < 86400000) return state.devices;
    let plantId = config.plant_id;
    if (!plantId) {
      state.plants = await api.plants(signal);
      if (state.plants.length !== 1) throw new Error(state.plants.length ? 'Meerdere installaties: stel growatt.cloud.plant_id in' : 'Geen Growatt-installaties gevonden');
      plantId = state.plants[0].plant_id;
    }
    state.plant_id = plantId;
    const result = await api.devices(plantId, signal);
    if (!result.length) throw new Error('Geen ondersteunde Growatt-omvormers gevonden');
    if (result.some((item) => !/^[A-Z0-9]{10}$/.test(item.serial) || !['min', 'inv'].includes(item.device_type))) throw new Error('Growatt: ongeldige omvormerlijst');
    state.devices = [...new Map(result.map((item) => [item.serial, item])).values()];
    state.discovered_ms = clock();
    return state.devices;
  }

  /** Haalt de ingestelde omvormers onafhankelijk op; input: geen; output: resultaat met aantallen en actuele status, fouten verhogen het volgende interval. */
  async function run() {
    const started = clock();
    controller = new AbortController();
    state.last_attempt_ms = started;
    state.next_ms = started + config.poll_seconds * 1000;
    persist();
    const errors = [];
    let measurements = 0, retryMs = 0;
    try {
      const targets = await devices(controller.signal);
      for (const device of targets) {
        if (stopping) break;
        try {
          const measurement = await api.read(device, controller.signal);
          repository.saveCloudInverter(measurement);
          measurements++;
        } catch (error) {
          if (stopping) break;
          errors.push(`${device.serial}: ${redactCloud(error.message, token)}`);
          retryMs = Math.max(retryMs, error.retry_after_ms ?? 0);
          if (error.http_status === 429 || [401, 403].includes(error.http_status) || Number(error.api_code) === 501) break;
        }
      }
    } catch (error) {
      if (!stopping) errors.push(redactCloud(error.message, token));
      retryMs = Math.max(retryMs, error.retry_after_ms ?? 0);
    }
    if (stopping) return { attempted: true, reason: 'stopped' };
    state.failures = errors.length ? (state.failures ?? 0) + 1 : 0;
    const wait = errors.length ? Math.max(Math.min(3600000, config.poll_seconds * 1000 * 2 ** Math.min(5, state.failures - 1)), retryMs) : config.poll_seconds * 1000;
    state.next_ms = clock() + wait;
    state.last_error = errors.length ? errors.join(' · ').slice(0, 1500) : null;
    state.status = errors.length ? (measurements ? 'partial' : 'error') : 'ok';
    state.last_measurement_count = measurements;
    if (measurements) state.last_success_ms = clock();
    persist();
    if (errors.length) repository.saveGrowattEvent(clock(), config.base_url, 'cloud_poll_error', state.last_error);
    return { attempted: true, reason: state.status, measurements, status: status() };
  }

  /** Probeert één geplande cloudcyclus; input: geen; output: Promise met poging of reden disabled/configuration/interval/daylight/busy. */
  function poll() {
    const result = (reason) => Promise.resolve({ attempted: false, reason, status: status() });
    if (stopping) return result('stopped');
    if (config.source === 'shinelink') return result('disabled');
    if (!token) return result('configuration');
    if (pending) return result('busy');
    const now = clock();
    if (now < (state.next_ms ?? 0)) return result('interval');
    if (config.daylight_only) {
      const day = localDay(now), sun = sunTimes(day);
      if (!sun) return result('sun_times');
      if (now < sun.sunrise_ms || now >= sun.sunset_ms) {
        const nextDay = now < sun.sunrise_ms ? day : new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
        state.next_ms = sunTimes(nextDay)?.sunrise_ms ?? now + config.poll_seconds * 1000;
        persist();
        return result('daylight');
      }
    }
    if (config.source === 'auto') {
      const serials = new Set(configured.map((item) => item.serial));
      const fresh = repository.currentInverters().filter((item) => (!serials.size || serials.has(item.serial)) && now >= item.measured_ms && now - item.measured_ms <= settings.growatt.fresh_minutes * 60000);
      if (fresh.length === settings.growatt.expected_inverters) return result('local_fresh');
    }
    pending = run().finally(() => { pending = null; controller = null; });
    return pending;
  }

  /** Geeft uitsluitend niet-geheime webbronstatus terug; input: geen; output: configuratie, planning, fouten en herkende omvormers. */
  function status() {
    const iso = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    return { enabled: config.source !== 'shinelink', configured: Boolean(token), production_source: config.source, base_url: config.base_url, token_env: config.token_env,
      fetching: pending !== null, poll_seconds: config.poll_seconds, daylight_only: config.daylight_only,
      state: config.source === 'shinelink' ? 'disabled' : !token ? 'configuration_incomplete' : state.status ?? 'waiting',
      last_error: config.source === 'shinelink' ? null : !token ? 'API-token ontbreekt' : state.last_error ?? null,
      last_attempt: iso(state.last_attempt_ms), last_success: iso(state.last_success_ms), next_fetch: iso(state.next_ms),
      plant_id: config.plant_id || state.plant_id || null, plants: state.plants ?? [], devices: configured.length ? configured : state.devices ?? [],
      last_measurement_count: state.last_measurement_count ?? 0, last_request: repository.diagnosticState('growatt', 'cloud_last_request') };
  }

  /** Start achtergrondcontrole zonder het Growatt-interval te verkorten; input: geen; output: void. */
  function start() {
    if (timer || stopping) return;
    void poll().catch((error) => console.error('Growatt cloud:', redactCloud(error.message, token)));
    timer = setInterval(() => { void poll().catch((error) => console.error('Growatt cloud:', redactCloud(error.message, token))); }, 15000);
  }

  /** Stopt nieuwe aanvragen en wacht op een lopende aanvraag voordat SQLite sluit; input: geen; output: Promise<void>. */
  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    controller?.abort();
    if (pending) await pending;
  }

  return { poll, start, stop, status };
}
