import { GROWATT_CLOUD_POLL_SECONDS } from '../growatt/cloud/config.js';

/** Bepaalt de maximale meetleeftijd per bron; input: ingestelde minuten en bron; output: minuten, voor kwartiercloudmetingen minimaal één interval plus vijf minuten marge. */
export function productionFreshnessMinutes(minutes, source) {
  return source === 'cloud' ? Math.max(minutes, GROWATT_CLOUD_POLL_SECONDS / 60 + 5) : minutes;
}
