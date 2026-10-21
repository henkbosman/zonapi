import { socketActivity } from '../appliances/socket-activity.js';
import { socketFreshnessMs } from '../appliances/socket-config.js';
import { cycleEnergyPoints } from '../appliances/cycle-energy.js';

/** Vormt een opgeslagen cyclus om naar tijd sinds de start en gemeten bronverdeling; input: cyclusrij, opslag, instellingen, peiltijd en omvormers; output: dashboardcyclus of null. */
function cycle(run, repository, settings, now, serials) {
  if (!run) return null;
  const end = run.ended_ms ?? run.last_ms;
  return { id: run.id, state: run.state, complete: run.complete, started_at: new Date(run.started_ms).toISOString(),
    ended_at: run.ended_ms === null ? null : new Date(run.ended_ms).toISOString(),
    duration_seconds: Math.max(0, (end - run.started_ms) / 1000), max_gap_seconds: run.gap_ms / 1000,
    energy_split_method: 'proportional_household',
    points: cycleEnergyPoints(run.points.filter((point) => point.measured_ms >= run.started_ms && point.measured_ms <= end), repository, settings, now, serials)
      .map((point) => ({ elapsed_seconds: (point.measured_ms - run.started_ms) / 1000, power_w: point.power_w,
        solar_power_w: point.solar_power_w, grid_power_w: point.grid_power_w })) };
}

/** Kiest de huidige/laatste cyclus en de voorafgaande volledig gemeten referentie; input: profiel, opslag, instellingen en peiltijd; output: apparaatgrafiek. */
export function applianceCycleResponse(profile, repository, settings, now, panels = null) {
  const activity = socketActivity(profile, repository, settings.homewizard.poll_seconds, now);
  const runs = repository.applianceCycles(profile.id);
  const current = runs.find((run) => run.state === 'active') ?? runs[0] ?? null;
  const previous = runs.find((run) => run.id !== current?.id && run.state === 'completed' && run.complete && run.started_ms < current.started_ms);
  const live = current?.state === 'active' && activity.running === true && Date.parse(activity.started_at) === current.started_ms;
  const elapsed = current ? Math.max(0, ((live ? now : current.ended_ms ?? current.last_ms) - current.started_ms) / 1000) : null;
  const serials = panels?.inverters.map((item) => item.serial) ?? [];
  return { id: profile.id, name: profile.name, configured: activity.configured, activity,
    current: cycle(current, repository, settings, now, serials), previous: cycle(previous, repository, settings, now, serials),
    live, elapsed_seconds: elapsed, fresh_seconds: socketFreshnessMs(settings.homewizard.poll_seconds) / 1000 };
}
