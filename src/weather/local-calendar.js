const partsFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Verschuift een geldige kalenderdatum zonder tijdzoneverschuiving; input: YYYY-MM-DD en geheel aantal dagen; output: YYYY-MM-DD of fout. */
export function addCalendarDays(day, offset = 0) {
  const parsed = /^\d{4}-\d\d-\d\d$/.test(day) ? Date.parse(`${day}T12:00:00Z`) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day || !Number.isInteger(offset)) throw new Error('date moet een geldige datum YYYY-MM-DD zijn');
  return new Date(parsed + offset * 86400000).toISOString().slice(0, 10);
}

/** Rekent Nederlandse middernacht om naar UTC; input: geldige kalenderdatum; output: epoch-ms. */
function midnight(day) {
  const utc = Date.parse(`${day}T00:00:00Z`);
  const parts = Object.fromEntries(partsFormatter.formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
  const localAsUtc = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  return utc - (localAsUtc - utc);
}

/** Bepaalt een lokale dag van 23, 24 of 25 uur; input: YYYY-MM-DD; output: {start_ms,end_ms} op Nederlandse middernacht. */
export function localDayRange(day) {
  return { start_ms: midnight(addCalendarDays(day)), end_ms: midnight(addCalendarDays(day, 1)) };
}
