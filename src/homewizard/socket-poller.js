import { fetchMeter, meterRequestUrl } from './client.js';
import { loadProfiles } from '../appliances/load-profiles.js';
import { socketConfig, socketConfigKey, socketFreshnessMs } from '../appliances/socket-config.js';
import { updateSocketActivity } from '../appliances/socket-activity.js';

/** Leest de Energy Socket per profiel zonder die als netmeter op te tellen; input: instellingen, opslag, profielenmap en optionele lezer/klok; output: poll/start/stop. */
export function createSocketPoller(settings, repository, directory, reader = fetchMeter, clock = Date.now) {
  let interval = null, active = null, stopped = false;

  /** Leest ingestelde sockets met afzonderlijke foutafhandeling; input: geen; output: Promise met aantal pogingen en profielmeldingen. */
  async function collect() {
    const { profiles, errors } = loadProfiles(directory);
    const sockets = [...profiles.values()].map((profile) => ({ profile, config: socketConfig(profile) })).filter((item) => item.config);
    await Promise.all(sockets.map(async ({ profile, config }) => {
      const key = socketConfigKey(config), device = `socket:${profile.id}`, started = clock();
      const saved = repository.applianceSocketState(profile.id);
      const previous = saved?.config_key === key ? saved.state : null;
      let measurement = null, state;
      try {
        measurement = await reader(device, config);
        state = updateSocketActivity(previous, measurement.net_power_w, config, clock(), socketFreshnessMs(settings.homewizard.poll_seconds));
      } catch (error) {
        state = { ...previous, pending_start_ms: null, pending_stop_ms: null, error: String(error.message).slice(0, 500) };
      }
      const at = clock();
      repository.saveApplianceSocketState({ appliance_id: profile.id, config_key: key, updated_ms: at, state });
      repository.saveHomeWizardCall({ attempted_ms: started, device, request_url: meterRequestUrl(config), duration_ms: Math.max(0, at - started),
        status: state.error ? 'error' : 'ok', detail: state.error, measurement: state.error ? null : measurement });
    }));
    return { attempted: true, sockets: sockets.length, errors };
  }

  /** Voorkomt overlappende socketrondes; input: geen; output: Promise met pollresultaat. */
  async function poll() {
    if (stopped || active) return { attempted: false, reason: stopped ? 'stopped' : 'busy' };
    active = collect();
    try { return await active; } finally { active = null; }
  }

  /** Start één achtergrondinterval; input: geen; output: void. */
  function start() {
    if (interval) return;
    stopped = false;
    const tick = () => { void poll().catch((error) => console.error('Energy Sockets:', error.message)); };
    tick();
    interval = setInterval(tick, settings.homewizard.poll_seconds * 1000);
  }

  /** Wacht bij afsluiten op lopende reads voordat SQLite sluit; input: geen; output: Promise<void>. */
  async function stop() { stopped = true; if (interval) clearInterval(interval); interval = null; if (active) await active; }

  return { poll, start, stop };
}
