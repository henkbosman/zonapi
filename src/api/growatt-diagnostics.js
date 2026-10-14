import { productionResponse } from './measurements.js';
import { decodeAnnouncement, recordLabel } from '../growatt/announcement.js';

/** Begrenst het aantal pakketten per aanvraag; input: querywaarde of null; output: geheel getal 1..100 of fout. */
export function growattLimitParam(value) {
  if (value === null) return 50;
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100) throw new Error('limit moet 1..100 zijn');
  return Number(value);
}

/** Valideert filters en paginering voor de Growatt-tijdlijn; input: URLSearchParams; output: filterobject of fout. */
export function growattTimelineParams(params) {
  const limit = growattLimitParam(params.get('limit'));
  const offset = params.get('offset') ?? '0';
  if (!/^(?:0|[1-9]\d{0,6})$/.test(offset)) throw new Error('offset moet 0..9999999 zijn');
  const type = (params.get('type') ?? '').toLowerCase();
  if (type && !/^(?:xx[0-9a-f]{2}|[0-9a-f]{4})$/.test(type)) throw new Error('type moet xx04 of een viercijferig hextype zijn');
  const address = (params.get('address') ?? '').toLowerCase();
  if (address && !/^(?:50|51|52|53)$/.test(address)) throw new Error('address moet 50..53 zijn');
  const view = params.get('view') ?? 'all';
  if (!['all', 'packets', 'errors', 'events'].includes(view)) throw new Error('view ongeldig');
  return { limit, offset: Number(offset), type, address, view };
}

/** Geeft de gefilterde pakket- en verbindingstijdlijn terug; input: repository en gevalideerde filters; output: JSON-geschikte regels en paginering. */
export function growattTimeline(repository, filters) {
  const { rows, has_more } = repository.growattTimeline(filters);
  return {
    ...filters, has_more,
    rows: rows.map((row) => ({ ...row, at: new Date(row.at_ms).toISOString(), label: row.source === 'packet' ? recordLabel(row.record_type) : ({ connected: 'Verbonden', disconnected: 'Verbinding gesloten', idle_disconnect: 'Inactiviteit', incomplete_timeout: 'Onvolledig pakket', incomplete_frame: 'Onvolledig pakket' })[row.status] ?? 'Verbinding' }))
  };
}

/** Stelt de Growatt-diagnose samen; input: repository, instellingen, panelen, huidige tijd en limiet; output: JSON-geschikt overzicht. */
export function growattOverview(repository, settings, panels, now, limit) {
  const statuses = repository.frameStatus();
  const frames = repository.recentGrowattFrames(limit);
  const announcements = repository.latestGrowattAnnouncements().map((row) => {
    const info = decodeAnnouncement(Buffer.from(row.raw));
    return info ? { ...info, frame_id: row.id, last_seen_at: new Date(row.received_ms).toISOString() } : null;
  }).filter(Boolean).sort((a, b) => a.address.localeCompare(b.address));
  return {
    server_time: new Date(now).toISOString(),
    listener: { host: settings.growatt.host, port: settings.growatt.port },
    summary: {
      frames_total: statuses.reduce((total, row) => total + row.count, 0),
      last_received_at: frames.length ? new Date(frames[0].received_ms).toISOString() : null
    },
    statuses,
    announcements,
    production: productionResponse(repository.currentInverters(), settings.growatt.expected_inverters, settings.growatt.fresh_minutes, now, panels.inverters.map((item) => item.serial)),
    frames: frames.map((frame) => ({ ...frame, label: recordLabel(frame.record_type), received_at: new Date(frame.received_ms).toISOString() })),
    problems: repository.recentGrowattProblems(20).map((problem) => ({ ...problem, at: new Date(problem.at_ms).toISOString() }))
  };
}

/** Toont de opgeslagen inhoud van één pakket; input: repository en positief pakket-id; output: JSON-geschikt pakket of null. */
export function growattFrameDetail(repository, id) {
  const row = repository.growattFrame(id);
  if (!row) return null;
  const decoded = repository.growattFrameMeasurement(id);
  return {
    id: row.id, received_at: new Date(row.received_ms).toISOString(), peer: row.peer,
    protocol: row.protocol, record_type: row.record_type, label: recordLabel(row.record_type), status: row.status,
    size_bytes: row.raw.length, raw_hex: Buffer.from(row.raw).toString('hex'),
    announcement: ['control', 'announcement'].includes(row.status) ? decodeAnnouncement(Buffer.from(row.raw)) : null,
    measurement: decoded ? { ...decoded, measured_at: new Date(decoded.measured_ms).toISOString() } : null
  };
}
