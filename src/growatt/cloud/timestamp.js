/** Leest een kalenderklok in één tijdzone; input: UTC-ms en Intl-formatter; output: lokale jaar/maand/dag/uur/minuut/seconde als UTC-ms. */
function wallClock(ms, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(ms).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** Zet een Growatt-tijd om naar UTC zonder de lokale Node-tijdzone te gebruiken; input: epoch, kalenderobject of datumtekst en expliciete tijdzone; output: epoch-ms of null bij een ontbrekende, ongeldige of dubbelzinnige klok. */
export function growattTimestamp(value, timezone) {
  if (value && typeof value === 'object') return growattTimestamp(value.timeInMillis ?? value.timeInMills, timezone);
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value))) {
    const number = Number(value);
    const ms = number < 100000000000 ? number * 1000 : number;
    return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2200, 0, 1) ? ms : null;
  }
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    const ms = Date.parse(value.replace(' ', 'T'));
    return Number.isFinite(ms) ? ms : null;
  }
  const match = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const nominal = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const offsets = new Set([-18, 0, 18].map((hours) => wallClock(nominal + hours * 3600000, formatter) - (nominal + hours * 3600000)));
  const candidates = [...offsets].map((offset) => nominal - offset).filter((ms) => wallClock(ms, formatter) === nominal);
  if (candidates.length !== 1 || new Date(nominal).toISOString().slice(0, 19) !== value.replace(' ', 'T')) return null;
  return candidates[0];
}
