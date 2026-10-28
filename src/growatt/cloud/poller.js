import { createHash } from 'node:crypto';
import { growattCloudConfig, growattCloudToken } from './config.js';
import { createGrowattCloudClient } from './client.js';
import { redactCloud } from './redact.js';
import { localDay } from '../../weather/local-day.js';
import { offlineSunTimes } from '../../weather/solar-position.js';
import { CLOUD_POLL_MS, nextPollSlot, pollSlotAtOrAfter, restoredPollSlot } from './schedule.js';
import { productionFreshnessMinutes } from '../../production/freshness.js';
import { correctionModelKey } from '../../pv/correction-key.js';

/** Maakt de Growatt-webbron op vaste vijfminutenmomenten; input: instellingen, panelen, opslag en optionele klok/omgeving/client/timers/callback; output: {poll,start,stop,status} met persistente foutwachttijd. */
export function createGrowattCloudPoller({ settings, panels, repository, clock = () => Date.now(), environment = process.env, client, onMeasurements, timers = { setTimeout, clearTimeout } }) {
  const config = growattCloudConfig(settings);
  const token = growattCloudToken(config, environment);
  const configured = panels.inverters.map((item) => item.serial).filter(Boolean).map((serial) => ({ serial, device_type: config.device_type }));
  const fingerprint = createHash('sha256').update(JSON.stringify([config.base_url, config.plant_id, config.device_type, token, configured])).digest('hex');
  let state = repository.diagnosticState('growatt', 'cloud') ?? {};
  if (state.fingerprint !== fingerprint) state = { fingerprint, failures: 0 };
  state.next_ms = restoredPollSlot(state, clock());
  let timer = null, pending = null, controller = null, stopping = false, running = false;
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
    state.last_slot_ms = Math.floor(started / CLOUD_POLL_MS) * CLOUD_POLL_MS;
    state.last_scheduled_ms = state.last_slot_ms;
    state.last_schedule_delay_ms = started - state.last_slot_ms;
    state.last_measurements = [];
    state.next_ms = nextPollSlot(started);
    persist();
    const errors = [];
    const observations = [];
    let measurements = 0, retryMs = 0;
    try {
      const targets = await devices(controller.signal);
      for (const device of targets) {
        if (stopping) break;
        try {
          const measurement = await api.read(device, controller.signal);
          repository.saveCloudInverter(measurement);
          observations.push(measurement);
          state.last_measurements.push({ serial: measurement.serial, requested_ms: measurement.requested_ms ?? null,
            measured_ms: measurement.measured_ms, received_ms: measurement.received_ms });
          measurements++;
        } catch (error) {
          if (stopping) break;
          errors.push(`${device.serial}: ${redactCloud(error.message, token)}`);
          retryMs = Math.max(retryMs, error.retry_after_ms ?? 0);
          if (error.http_status === 429 || [401, 403].includes(error.http_status) || [102, 501].includes(Number(error.api_code))) break;
        }
      }
    } catch (error) {
      if (!stopping) errors.push(redactCloud(error.message, token));
      retryMs = Math.max(retryMs, error.retry_after_ms ?? 0);
    }
    if (stopping) return { attempted: true, reason: 'stopped' };
    if (onMeasurements) {
      if (errors.length) state.forecast_correction = { status: 'incomplete' };
      else {
        try { state.forecast_correction = onMeasurements(observations, clock()); }
        catch (error) {
          state.forecast_correction = { status: 'error', message: redactCloud(error.message, token) };
          repository.saveGrowattEvent(clock(), config.base_url, 'forecast_correction_error', state.forecast_correction.message);
        }
      }
    }
    state.failures = errors.length ? (state.failures ?? 0) + 1 : 0;
    const finished = clock();
    const backoff = Math.min(3600000, CLOUD_POLL_MS * 2 ** Math.min(5, state.failures - 1));
    state.retry_not_before_ms = errors.length ? Math.max(started + backoff, finished + retryMs) : 0;
    state.next_ms = Math.max(nextPollSlot(Math.max(started, finished)), pollSlotAtOrAfter(state.retry_not_before_ms));
    state.last_error = errors.length ? errors.join(' · ').slice(0, 1500) : null;
    state.status = errors.length ? (measurements ? 'partial' : 'error') : 'ok';
    state.last_measurement_count = measurements;
    if (measurements) state.last_success_ms = clock();
    persist();
    if (errors.length) repository.saveGrowattEvent(clock(), config.base_url, 'cloud_poll_error', state.last_error);
    return { attempted: true, reason: state.status, measurements, forecast_correction: state.forecast_correction ?? null, status: status() };
  }

  /** Probeert één geplande cloudcyclus; input: geen; output: Promise met poging of reden disabled/configuration/interval/daylight/busy. */
  function poll() {
    const result = (reason) => Promise.resolve({ attempted: false, reason, status: status() });
    if (stopping) return result('stopped');
    if (config.source === 'shinelink') return result('disabled');
    if (!token) return result('configuration');
    if (pending) return result('busy');
    const now = clock();
    if (now < state.next_ms) return result('interval');
    // Een korte timervertraging mag; gemiste vijfminutenmomenten worden nooit later in het vijfminutenvak ingehaald.
    if (now % CLOUD_POLL_MS >= 60000) {
      state.next_ms = nextPollSlot(now);
      persist();
      return result('interval');
    }
    if (config.daylight_only) {
      const day = localDay(now), sun = sunTimes(day);
      if (!sun) { state.next_ms = nextPollSlot(now); persist(); return result('sun_times'); }
      if (now < sun.sunrise_ms || now >= sun.sunset_ms) {
        const nextDay = now < sun.sunrise_ms ? day : new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
        state.next_ms = Math.max(nextPollSlot(now), pollSlotAtOrAfter(sunTimes(nextDay)?.sunrise_ms ?? nextPollSlot(now)));
        persist();
        return result('daylight');
      }
    }
    if (config.source === 'auto') {
      const serials = new Set(configured.map((item) => item.serial));
      const fresh = repository.currentInverters().filter((item) => (!serials.size || serials.has(item.serial)) && now >= item.measured_ms && now - item.measured_ms <= settings.growatt.fresh_minutes * 60000);
      if (fresh.length === settings.growatt.expected_inverters) {
        state.last_slot_ms = Math.floor(now / CLOUD_POLL_MS) * CLOUD_POLL_MS;
        state.next_ms = nextPollSlot(now);
        persist();
        return result('local_fresh');
      }
    }
    pending = run().finally(() => { pending = null; controller = null; arm(); });
    return pending;
  }

  /** Geeft uitsluitend niet-geheime webbronstatus terug; input: geen; output: configuratie, planning, fouten en herkende omvormers. */
  function status() {
    const iso = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    const attempt = repository.diagnosticState('growatt', 'pv_correction');
    const attempted = Date.parse(attempt?.attempted_at);
    let correction = attempt && attempt.model_key === correctionModelKey(settings, panels) && attempted <= clock()
      && attempted >= (state.last_attempt_ms ?? -Infinity) ? attempt : state.forecast_correction;
    if (correction === attempt && ['updated', 'unchanged'].includes(attempt?.status)) {
      const block = repository.pvBlockCorrection(attempt.model_key, Date.parse(attempt.target_time));
      if (block) correction = { ...attempt, sampling: JSON.parse(block.sampling_json) };
    }
    return { enabled: config.source !== 'shinelink', configured: Boolean(token), production_source: config.source, base_url: config.base_url, token_env: config.token_env,
      fetching: pending !== null, poll_seconds: config.poll_seconds, poll_schedule: config.poll_schedule,
      fresh_minutes: productionFreshnessMinutes(settings.growatt.fresh_minutes, 'cloud'), daylight_only: config.daylight_only,
      state: config.source === 'shinelink' ? 'disabled' : !token ? 'configuration_incomplete' : state.status ?? 'waiting',
      last_error: config.source === 'shinelink' ? null : !token ? 'API-token ontbreekt' : state.last_error ?? null,
      last_attempt: iso(state.last_attempt_ms), last_success: iso(state.last_success_ms), next_fetch: config.source === 'shinelink' || !token ? null : iso(state.next_ms),
      last_scheduled: Number.isFinite(state.last_attempt_ms) ? iso(state.last_scheduled_ms ?? Math.floor(state.last_attempt_ms / CLOUD_POLL_MS) * CLOUD_POLL_MS) : null,
      schedule_delay_ms: state.last_schedule_delay_ms ?? null,
      last_measurements: (state.last_measurements ?? []).map((row) => ({ serial: row.serial,
        requested_at: iso(row.requested_ms), measured_at: iso(row.measured_ms), received_at: iso(row.received_ms),
        age_at_receipt_seconds: Number.isFinite(row.received_ms) ? (row.received_ms - row.measured_ms) / 1000 : null })),
      plant_id: config.plant_id || state.plant_id || null, plants: state.plants ?? [], devices: configured.length ? configured : state.devices ?? [],
      last_measurement_count: state.last_measurement_count ?? 0, forecast_correction: correction ?? null,
      last_request: repository.diagnosticState('growatt', 'cloud_last_request') };
  }

  /** Plant één timer op het volgende vijfminutenmoment; input: geen; output: void, zonder relatieve intervalverschuiving. */
  function arm() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (!running || stopping || config.source === 'shinelink' || !token) return;
    timer = timers.setTimeout(() => { timer = null; void tick(); }, Math.max(1, state.next_ms - clock()));
  }

  /** Voert de achtergrondpoging uit en plant daarna opnieuw; input: geen; output: Promise<void>. */
  async function tick() {
    try { const result = await poll(); if (!result.attempted) arm(); }
    catch (error) {
      console.error('Growatt cloud:', redactCloud(error.message, token));
      state.next_ms = nextPollSlot(clock());
      arm();
    }
  }

  /** Start ophalen op :00, :05, :10, … en :55; input: geen; output: void, herhaald starten maakt geen extra timer. */
  function start() {
    if (running || stopping) return;
    running = true;
    void tick();
  }

  /** Stopt nieuwe aanvragen en wacht op een lopende aanvraag voordat SQLite sluit; input: geen; output: Promise<void>. */
  async function stop() {
    stopping = true;
    running = false;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    controller?.abort();
    if (pending) await pending;
  }

  return { poll, start, stop, status };
}
