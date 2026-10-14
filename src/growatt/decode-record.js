import { xorPayload } from './mask.js';
import { selectLayout } from './layouts.js';

const localFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Leest een tienletterig serienummer uit het pakket; input: plaintext Buffer en byteoffset; output: serienummer of null. */
export function readSerial(plain, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 10 > plain.length) return null;
  const serial = plain.subarray(offset, offset + 10).toString('ascii');
  return /^[A-Z0-9]{10}$/.test(serial) ? serial : null;
}

/** Zet apparaatklok in Europe/Amsterdam om naar UTC, ook rond zomertijd; input: zes tijdsbytes en ontvangst-ms; output: UTC ms of null. */
export function parseDeviceTime(bytes, receivedMs) {
  if (bytes.length !== 6) return null;
  const [year, month, day, hour, minute, second] = bytes;
  if (year > 99 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const desired = `20${String(year).padStart(2, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  const naive = Date.UTC(2000 + year, month - 1, day, hour, minute, second);
  const candidates = [naive - 3600000, naive - 7200000].filter((ms) => {
    const parts = Object.fromEntries(localFormatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` === desired && ms <= receivedMs + 300000;
  });
  return candidates.length ? candidates.sort((a, b) => Math.abs(receivedMs - a) - Math.abs(receivedMs - b))[0] : null;
}

/** Leest alleen gevalideerde AC-metingen uit een bekende layout; input: geldig frame, layoutmap, ontvangst-ms; output: meting of null. */
export function decodeRecord(frame, directory, receivedMs) {
  const kind = frame[7];
  const layout = selectLayout(frame[3], frame[6], kind, frame.length, directory);
  if (!layout) return null;
  const plain = frame[3] === 2 ? frame : xorPayload(frame.subarray(0, -2));
  const { serial: offset, date, power, today, total } = layout.offsets;
  const serial = readSerial(plain, offset);
  if (!serial || ![date, power, today, total].every((value) => Number.isInteger(value) && value >= 0)) return null;
  if (Math.max(date + 6, power + 4, today + 4, total + 4) > plain.length) return null;
  const rawPower = plain.readInt32BE(power) / 10;
  if (rawPower < 0 || rawPower > 10000) return null;
  const energyToday = plain.readUInt32BE(today) / 10;
  const energyTotal = plain.readUInt32BE(total) / 10;
  const time = parseDeviceTime(plain.subarray(date, date + 6), receivedMs);
  if (kind === 0x50 && time === null) return null; // Oude buffer heeft een echte apparaatklok nodig.
  return { serial, measured_ms: time ?? receivedMs, received_ms: receivedMs, power_w: rawPower, energy_today_kwh: energyToday, energy_total_kwh: energyTotal, layout: layout.id, clock_fallback: time === null };
}
