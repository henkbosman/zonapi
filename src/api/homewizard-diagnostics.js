import { weatherCallParams } from './weather-diagnostics.js';
import { metersResponse } from './measurements.js';
import { meterRequestUrl } from '../homewizard/client.js';
import { socketConfig } from '../appliances/socket-config.js';
import { socketActivity } from '../appliances/socket-activity.js';

/** Valideert filters voor lokale meterlogs; input: URLSearchParams; output: status, apparaat en paginering of fout. */
export function homeWizardCallParams(params) {
  const filters = weatherCallParams(params);
  const device = params.get('device') ?? 'all';
  if (!['all', 'p1', 'kwh'].includes(device) && !/^socket:[a-z0-9_-]+$/.test(device)) throw new Error('device moet all, p1, kwh of een socket-id zijn');
  if (filters.status === 'pending') throw new Error('status moet all, ok of error zijn');
  return { ...filters, device };
}

/** Stelt lokale meterinformatie en poll-diagnose samen; input: repository, instellingen, poller, tijd-ms en filters; output: JSON-overzicht. */
export function homeWizardOverview(repository, settings, poller, now, filters, profiles = []) {
  const measurements = metersResponse(repository.currentMeters(), now, settings.homewizard.net_meter_priority);
  const errors = poller.status();
  const page = repository.recentHomeWizardCalls(filters);
  return {
    server_time: new Date(now).toISOString(),
    logging: repository.loggingStatus('homewizard'),
    poll_seconds: settings.homewizard.poll_seconds,
    ...measurements,
    devices: [...['p1', 'kwh'].map((device) => {
      const config = settings.homewizard[device];
      let url = null;
      try { if (config.host) url = meterRequestUrl(config); } catch { /* Ongeldige host staat in de apparaatfout. */ }
      return { device, name: device === 'p1' ? 'P1' : 'kWh-meter', kind: 'meter', host: config.host || null, api: config.api, configured: Boolean(config.host), request_url: url,
        error: errors[device] ?? null, latest_call: repository.diagnosticState('homewizard', device),
        measurement: measurements.meters.find((row) => row.device === device) ?? null };
    }), ...profiles.flatMap((profile) => {
      const config = socketConfig(profile);
      if (!config) return [];
      const device = `socket:${profile.id}`, requestUrl = meterRequestUrl(config);
      const activity = socketActivity(profile, repository, settings.homewizard.poll_seconds, now);
      const call = repository.diagnosticState('homewizard', device);
      const latest = call?.request_url === requestUrl ? call : null;
      return [{ device, name: profile.name, kind: 'socket', host: config.host, api: config.api, configured: true,
        request_url: requestUrl, error: activity.error, activity, latest_call: latest,
        measurement: activity.measured_at ? { device, measured_at: activity.measured_at,
          fresh: ['running', 'starting', 'idle'].includes(activity.state), net_power_w: activity.power_w,
          import_kwh: latest?.measurement?.import_kwh ?? null, export_kwh: latest?.measurement?.export_kwh ?? null } : null }];
    })],
    calls: { ...filters, ...page }
  };
}
