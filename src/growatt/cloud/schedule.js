import { GROWATT_CLOUD_POLL_SECONDS } from './config.js';

export const CLOUD_POLL_MS = GROWATT_CLOUD_POLL_SECONDS * 1000;

/** Kiest het eerste vijfminutenmoment op of na een tijdstip; input: UTC-ms; output: UTC-ms op :00/:05/:10/…/:55, ook bij zomer-/wintertijd. */
export function pollSlotAtOrAfter(ms) { return Math.ceil(ms / CLOUD_POLL_MS) * CLOUD_POLL_MS; }

/** Kiest het eerstvolgende vijfminutenmoment; input: UTC-ms; output: UTC-ms strikt na de gegeven tijd. */
export function nextPollSlot(ms) { return (Math.floor(ms / CLOUD_POLL_MS) + 1) * CLOUD_POLL_MS; }

/** Herstelt de klokplanning met behoud van eerdere pogingen en foutwachttijden; input: opgeslagen status en huidige tijd; output: volgend vijfminutenmoment zonder inhaalverzoek. */
export function restoredPollSlot(state, now) {
  const retryUntil = state.retry_not_before_ms ?? (state.failures > 0 ? state.next_ms : 0);
  const lastAttempt = Number.isFinite(state.last_attempt_ms) ? state.last_attempt_ms : null;
  const afterSlot = Number.isFinite(state.last_slot_ms) ? state.last_slot_ms + CLOUD_POLL_MS : 0;
  // Bij de overgang van de oude planning wordt ook de toenmalige minimale wachttijd van vijf minuten behouden.
  return pollSlotAtOrAfter(Math.max(now, retryUntil ?? 0, afterSlot,
    lastAttempt === null ? 0 : Math.max(lastAttempt + 300000, nextPollSlot(lastAttempt))));
}
