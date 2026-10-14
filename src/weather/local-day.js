const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Geeft de Nederlandse kalenderdag voor een UTC-tijdstip; input: epoch ms; output: YYYY-MM-DD. */
export function localDay(ms) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
