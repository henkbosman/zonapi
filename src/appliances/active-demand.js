import { socketConfig, socketConfigKey, socketFreshnessMs } from './socket-config.js';

/** Zoekt het eerste segment waarvan het einde na het tijdstip ligt; input: segmenten en tijd-ms; output: index. */
function segmentIndex(segments, at) {
  let left = 0, right = segments.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (segments[middle].until <= at) left = middle + 1; else right = middle;
  }
  return left;
}

/** Leest een lineair segment zonder gaten te vullen; input: segmenten en tijd-ms; output: segment of null. */
function segmentAt(segments, at) {
  const segment = segments[segmentIndex(segments, at)];
  return segment && segment.from <= at ? segment : null;
}

/** Leest het vermogen op een punt binnen een segment; input: segment en tijd-ms; output: watt. */
function powerAt(segment, at) { return segment.first + (segment.last - segment.first) * (at - segment.from) / (segment.until - segment.from); }

/** Verplaatst een JSON-programma naar de herkende starttijd; input: profiel en start-ms; output: constante vermogenssegmenten. */
function profileSegments(profile, start) {
  let from = start;
  return profile.steps.map((step) => {
    const until = from + step.duration_minutes * 60000;
    const segment = { from, until, first: step.power_w, last: step.power_w };
    from = until; return segment;
  });
}

/** Verplaatst de vorige volledige cyclus naar de huidige start; input: opgeslagen referentie en start-ms; output: lineaire segmenten. */
function cycleSegments(reference, start) {
  const segments = [];
  for (let index = 1; index < reference.points.length; index++) {
    const a = reference.points[index - 1], b = reference.points[index];
    if (b.measured_ms <= a.measured_ms || b.measured_ms - a.measured_ms > reference.gap_ms) continue;
    if (![a.power_w, b.power_w].every((power) => Number.isFinite(power) && power >= 0)) continue;
    segments.push({ from: start + a.measured_ms - reference.started_ms, until: start + b.measured_ms - reference.started_ms, first: a.power_w, last: b.power_w });
  }
  return segments;
}

/** Berekent de nog verwachte belasting van één actief apparaat; input: profiel, bewaarde toestand, instellingen, opslag en peiltijd; output: belasting of null. */
function remainingLoad(profile, saved, config, repository, settings, now) {
  if (!saved || saved.config_key !== socketConfigKey(config)) return null;
  const state = saved.state, pollSeconds = settings.homewizard?.poll_seconds ?? 30;
  const fresh = !state.error && Number.isFinite(state.measured_ms) && now >= state.measured_ms && now - state.measured_ms <= socketFreshnessMs(pollSeconds);
  const pending = fresh && !state.running && Number.isFinite(state.pending_start_ms);
  if (state.running !== true && !pending) return null;
  const identifiedStart = pending ? state.pending_start_ms : state.started_ms;
  const start = Number.isFinite(identifiedStart) && identifiedStart <= now ? identifiedStart : now;
  const programmed = profileSegments(profile, start), duration = programmed.at(-1).until - start;
  const peak = Math.max(...profile.steps.map((step) => step.power_w));
  const reference = repository.applianceCycles(profile.id).find((run) => run.state === 'completed' && run.complete && run.started_ms < start
    && run.ended_ms > run.started_ms && run.points.length >= 2);
  const learned = reference ? cycleSegments(reference, start) : [];
  let until = reference ? start + reference.ended_ms - reference.started_ms : start + duration;
  let source = reference ? 'previous_cycle' : 'profile';
  const overrun = until <= now;
  const currentPower = Number.isFinite(state.power_w) && state.power_w >= 0 ? state.power_w : null;
  let segments;
  if (overrun) {
    // Een apparaat dat nog aan staat mag niet op grond van een verstreken profiel verdwijnen.
    until = now + Math.min(24 * 3600000, Math.max(5 * 60000, duration));
    const power = fresh && currentPower !== null ? currentPower : Math.max(currentPower ?? 0, peak);
    segments = [{ from: now, until, first: power, last: power }];
    source = 'current_power';
  } else {
    const actualUntil = fresh && currentPower !== null ? Math.min(until, now + pollSeconds * 1000) : now;
    const boundaries = new Set([now, until, actualUntil]);
    for (const segment of [...programmed, ...learned]) {
      if (segment.from > now && segment.from < until) boundaries.add(segment.from);
      if (segment.until > now && segment.until < until) boundaries.add(segment.until);
    }
    const ordered = [...boundaries].sort((a, b) => a - b);
    segments = [];
    for (let index = 1; index < ordered.length; index++) {
      const from = ordered[index - 1], end = ordered[index];
      if (end <= from) continue;
      const segment = segmentAt(learned, from) ?? segmentAt(programmed, from);
      const actual = from < actualUntil;
      segments.push({ from, until: end, first: actual ? currentPower : segment ? powerAt(segment, from) : peak,
        last: actual ? currentPower : segment ? powerAt(segment, end) : peak });
    }
  }
  return { id: profile.id, until, segments, metadata: { id: profile.id, name: profile.name, state: pending ? 'starting' : fresh ? 'running' : 'last_known_running',
    source, fresh, overrun, power_w: fresh ? currentPower : null, started_at: new Date(start).toISOString(),
    expected_end: new Date(until).toISOString(), remaining_minutes: Math.ceil((until - now) / 60000) } };
}

/** Telt gelijktijdige lineaire vermogenssegmenten op; input: afzonderlijke belastingen; output: één geordende vermogensreeks. */
function totalSegments(loads) {
  const events = new Map();
  const event = (at, power, slope) => { const value = events.get(at) ?? { power: 0, slope: 0 }; value.power += power; value.slope += slope; events.set(at, value); };
  for (const load of loads) for (const segment of load.segments) {
    const slope = (segment.last - segment.first) / (segment.until - segment.from);
    event(segment.from, segment.first, slope); event(segment.until, -segment.last, -slope);
  }
  let last = null, power = 0, slope = 0;
  const segments = [];
  for (const [at, change] of [...events].sort((a, b) => a[0] - b[0])) {
    if (last !== null && at > last) {
      const end = power + slope * (at - last);
      segments.push({ from: last, until: at, first: Math.max(0, power), last: Math.max(0, end) });
      power = end;
    }
    power += change.power; slope += change.slope; last = at;
  }
  return segments;
}

/** Integreert lineair beschikbaar vermogen na begrenzing op nul en apparaatvermogen; input: begin/eindwatt, apparaatwatt en uren; output: Wh. */
export function clippedSolarEnergy(first, last, demand, hours) {
  if (demand <= 0 || hours <= 0) return 0;
  const cuts = [0, 1];
  if (last !== first) for (const level of [0, demand]) {
    const fraction = (level - first) / (last - first);
    if (fraction > 0 && fraction < 1) cuts.push(fraction);
  }
  cuts.sort((a, b) => a - b);
  const clip = (fraction) => Math.max(0, Math.min(demand, first + (last - first) * fraction));
  let energy = 0;
  for (let index = 1; index < cuts.length; index++) energy += (clip(cuts[index - 1]) + clip(cuts[index])) / 2 * (cuts[index] - cuts[index - 1]) * hours;
  return energy;
}

/** Maakt één gedeelde reservering voor alle daadwerkelijk actieve apparaten; input: profielen, opslag, instellingen en peiltijd; output: metadata, eigen bezettijd en zonne-energie na lopend verbruik. */
export function createActiveDemand(profiles, repository, settings, now) {
  const loads = [];
  for (const profile of profiles) {
    const config = socketConfig(profile);
    if (!config) continue;
    const load = remainingLoad(profile, repository.applianceSocketState(profile.id), config, repository, settings, now);
    if (load) loads.push(load);
  }
  const segments = totalSegments(loads);
  return {
    metadata: loads.map((load) => load.metadata),
    /** Geeft de verwachte vrijgave van dit apparaat; input: apparaat-id; output: tijd-ms of null. */
    busyUntil(id) { return loads.find((load) => load.id === id)?.until ?? null; },
    /** Verdeelt zonnestroom na basislast/reserve en alle actieve verbruiksfasen; input: tijdvenster, beschikbare PV-watt en nieuw apparaatvermogen; output: Wh. */
    solarWh(from, until, available, demand) {
      let index = segmentIndex(segments, from), cursor = from, energy = 0;
      while (cursor < until) {
        const segment = segments[index];
        if (!segment || cursor < segment.from) {
          const end = Math.min(until, segment?.from ?? until);
          energy += Math.max(0, Math.min(demand, available)) * (end - cursor) / 3600000;
          cursor = end;
        } else {
          const end = Math.min(until, segment.until);
          energy += clippedSolarEnergy(available - powerAt(segment, cursor), available - powerAt(segment, end), demand, (end - cursor) / 3600000);
          cursor = end;
          if (cursor >= segment.until) index++;
        }
      }
      return energy;
    }
  };
}
