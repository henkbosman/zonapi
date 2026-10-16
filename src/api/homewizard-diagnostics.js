import { weatherCallParams } from './weather-diagnostics.js';
import { metersResponse } from './measurements.js';
import { meterRequestUrl } from '../homewizard/client.js';

/** Valideert filters voor lokale meterlogs; input: URLSearchParams; output: status, apparaat en paginering of fout. */
export function homeWizardCallParams(params) {
  const filters = weatherCallParams(params);
  const device = params.get('device') ?? 'all';
  if (!['all', 'p1', 'kwh'].includes(device)) throw new Error('device moet all, p1 of kwh zijn');
  if (filters.status === 'pending') throw new Error('status moet all, ok of error zijn');
  return { ...filters, device };
}

/** Stelt lokale meterinformatie en poll-diagnose samen; input: repository, instellingen, poller, tijd-ms en filters; output: JSON-overzicht. */
export function homeWizardOverview(repository, settings, poller, now, filters) {
  const measurements = metersResponse(repository.currentMeters(), now, settings.homewizard.net_meter_priority);
  const errors = poller.status();
  const page = repository.recentHomeWizardCalls(filters);
  return {
    server_time: new Date(now).toISOString(),
    logging: repository.loggingStatus('homewizard'),
    poll_seconds: settings.homewizard.poll_seconds,
    ...measurements,
    devices: ['p1', 'kwh'].map((device) => {
      const config = settings.homewizard[device];
      let url = null;
      try { if (config.host) url = meterRequestUrl(config); } catch { /* Ongeldige host staat in de apparaatfout. */ }
      return { device, host: config.host || null, api: config.api, configured: Boolean(config.host), request_url: url,
        error: errors[device] ?? null, latest_call: repository.diagnosticState('homewizard', device),
        measurement: measurements.meters.find((row) => row.device === device) ?? null };
    }),
    calls: { ...filters, ...page }
  };
}
