/** Houdt per TCP-verbinding bij wanneer een tijdopdracht nodig is; input: aantal omvormers en herhaalinterval in minuten; output: {shouldSync, receivedMeasurement}. */
export function createClockPolicy(expectedInverters, retryMinutes = 10) {
  const measuredAddresses = new Set();
  let lastSyncMs = -Infinity;
  const retryMs = retryMinutes * 60000;
  return {
    /** Beslist bij een aanmelding over een tijdopdracht; input: tijd in milliseconden; output: boolean. */
    shouldSync(nowMs) {
      if (measuredAddresses.size >= expectedInverters || nowMs - lastSyncMs < retryMs) return false;
      lastSyncMs = nowMs;
      return true;
    },
    /** Noteert een werkelijk ontvangen meetpakket; input: Growatt-adres als byte; output: void. */
    receivedMeasurement(address) { measuredAddresses.add(address); }
  };
}
