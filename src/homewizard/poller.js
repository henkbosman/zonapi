import { fetchMeter, meterRequestUrl } from './client.js';

/** Plant onafhankelijke LAN-metingen van P1 en kWh; input: instellingen en repository, optionele fetcher; output: {poll,start,stop,status}. */
export function createHomeWizardPoller(settings, repository, reader = fetchMeter) {
  let interval = null;
  let busy = false;
  const errors = { p1: null, kwh: null };
  for (const device of ['p1', 'kwh']) {
    const previous = repository.diagnosticState('homewizard', device);
    if (previous?.status === 'error') errors[device] = previous.detail;
  }

  /** Leest beide ingestelde apparaten, onafhankelijk van elkaars fouten; input: geen; output: Promise<{attempted,reason?}>. */
  async function poll() {
    if (busy) return { attempted: false, reason: 'busy' };
    busy = true;
    try {
      await Promise.all(['p1', 'kwh'].map(async (device) => {
        const config = settings.homewizard[device];
        if (!config?.host) { errors[device] = 'host niet ingesteld'; return; }
        const started = Date.now();
        let url = '', measurement = null;
        try {
          url = meterRequestUrl(config);
          measurement = await reader(device, config);
          repository.saveMeter(measurement);
          errors[device] = null;
        } catch (error) { errors[device] = error.message; }
        repository.saveHomeWizardCall({ attempted_ms: started, device, request_url: url, duration_ms: Date.now() - started,
          status: errors[device] ? 'error' : 'ok', detail: errors[device], measurement });
      }));
    } finally { busy = false; }
    return { attempted: true };
  }

  /** Start het pollinterval; input: geen; output: void. */
  function start() { void poll(); interval = setInterval(() => { void poll(); }, settings.homewizard.poll_seconds * 1000); }

  /** Stopt het pollinterval; input: geen; output: void. */
  function stop() { if (interval) clearInterval(interval); }

  /** Leest de actuele apparaatfouten; input: geen; output: kopie van foutstatus. */
  function status() { return { ...errors }; }

  return { poll, start, stop, status };
}
