import { productionResponse } from './measurements.js';

/** Begrenst het aantal pakketten per aanvraag; input: querywaarde of null; output: geheel getal 1..100 of fout. */
export function growattLimitParam(value) {
  if (value === null) return 50;
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100) throw new Error('limit moet 1..100 zijn');
  return Number(value);
}

/** Stelt de Growatt-diagnose samen; input: repository, instellingen, panelen, huidige tijd en limiet; output: JSON-geschikt overzicht. */
export function growattOverview(repository, settings, panels, now, limit) {
  const statuses = repository.frameStatus();
  const frames = repository.recentGrowattFrames(limit);
  return {
    listener: { host: settings.growatt.host, port: settings.growatt.port },
    summary: {
      frames_total: statuses.reduce((total, row) => total + row.count, 0),
      last_received_at: frames.length ? new Date(frames[0].received_ms).toISOString() : null
    },
    statuses,
    production: productionResponse(repository.currentInverters(), settings.growatt.expected_inverters, settings.growatt.fresh_minutes, now, panels.inverters.map((item) => item.serial)),
    frames: frames.map((frame) => ({ ...frame, received_at: new Date(frame.received_ms).toISOString() })),
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
    protocol: row.protocol, record_type: row.record_type, status: row.status,
    size_bytes: row.raw.length, raw_hex: Buffer.from(row.raw).toString('hex'),
    measurement: decoded ? { ...decoded, measured_at: new Date(decoded.measured_ms).toISOString() } : null
  };
}
