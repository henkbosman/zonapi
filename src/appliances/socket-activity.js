import { socketConfig, socketConfigKey, socketFreshnessMs } from './socket-config.js';

/** Herkent starten en stoppen met afzonderlijke grenzen en wachttijden; input: vorige status, watt, configuratie, meettijd en maximale meetpauze; output: nieuwe status. */
export function updateSocketActivity(previous, power, config, at, maxGapMs) {
  if (!Number.isFinite(power)) throw new Error('Energy Socket geeft geen geldig vermogen');
  const continuous = previous?.measured_ms !== null && previous?.measured_ms !== undefined && at >= previous.measured_ms && at - previous.measured_ms <= maxGapMs;
  const state = continuous ? { ...previous } : { running: false, started_ms: null, stopped_ms: null };
  if (!continuous || previous.error) { state.pending_start_ms = null; state.pending_stop_ms = null; }
  state.measured_ms = at;
  state.power_w = Math.max(0, power);
  state.error = null;
  if (state.running) {
    state.pending_start_ms = null;
    if (state.power_w <= config.stop_threshold_w) {
      state.pending_stop_ms ??= at;
      if (at - state.pending_stop_ms >= config.stop_delay_seconds * 1000) {
        state.running = false;
        state.stopped_ms = at;
        state.pending_stop_ms = null;
      }
    } else state.pending_stop_ms = null;
  } else {
    state.pending_stop_ms = null;
    if (state.power_w >= config.start_threshold_w) {
      state.pending_start_ms ??= at;
      if (at - state.pending_start_ms >= config.start_delay_seconds * 1000) {
        state.running = true;
        state.started_ms = state.pending_start_ms;
        state.stopped_ms = null;
        state.pending_start_ms = null;
      }
    } else state.pending_start_ms = null;
  }
  return state;
}

/** Vormt de laatste socketmeting om naar een actuele apparaatstatus; input: profiel, opslag, pollinterval en peiltijd; output: veilig dashboardobject. */
export function socketActivity(profile, repository, pollSeconds, now) {
  const config = socketConfig(profile);
  const empty = { configured: Boolean(config), state: config ? 'waiting' : 'not_configured', running: null, power_w: null,
    measured_at: null, started_at: null, stopped_at: null, error: null };
  if (!config) return empty;
  const saved = repository.applianceSocketState(profile.id);
  if (!saved || saved.config_key !== socketConfigKey(config)) return empty;
  const state = saved.state;
  const fresh = Number.isFinite(state.measured_ms) && now >= state.measured_ms && now - state.measured_ms <= socketFreshnessMs(pollSeconds);
  const available = fresh && !state.error;
  return { ...empty, state: available ? state.running ? 'running' : state.pending_start_ms !== null ? 'starting' : 'idle' : 'unavailable',
    running: available ? state.running : null, power_w: available ? state.power_w : null,
    measured_at: Number.isFinite(state.measured_ms) ? new Date(state.measured_ms).toISOString() : null,
    started_at: available && state.running && Number.isFinite(state.started_ms) ? new Date(state.started_ms).toISOString() : null,
    stopped_at: Number.isFinite(state.stopped_ms) ? new Date(state.stopped_ms).toISOString() : null,
    error: state.error ?? (fresh ? null : 'Geen recente socketmeting') };
}
