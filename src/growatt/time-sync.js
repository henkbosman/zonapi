import { xorPayload } from './mask.js';
import { modbusCrc } from './crc.js';
import { decodeAnnouncement } from './announcement.js';

const localClock = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Bouwt Grott's lokale datalogger-tijdopdracht voor register 31; input: geldig v06-03-aanmeldframe en UTC-ms; output: v06-18 Buffer of null. */
export function timeSyncCommand(announcement, nowMs) {
  if (announcement[3] !== 6 || announcement[7] !== 0x03) return null;
  const serial = decodeAnnouncement(announcement)?.datalogger_serial;
  if (!serial) return null;
  const parts = Object.fromEntries(localClock.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
  const localTime = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  const plain = Buffer.alloc(8 + 10 + 20 + 2 + 2 + localTime.length);
  plain.writeUInt16BE(1, 0);
  plain[3] = 6;
  plain.writeUInt16BE(plain.length - 6, 4);
  plain[6] = 1;
  plain[7] = 0x18;
  plain.write(serial, 8, 'ascii');
  plain.writeUInt16BE(31, 38);
  plain.writeUInt16BE(localTime.length, 40);
  plain.write(localTime, 42, 'ascii');
  const encrypted = xorPayload(plain);
  const command = Buffer.alloc(encrypted.length + 2);
  encrypted.copy(command);
  command.writeUInt16BE(modbusCrc(encrypted), encrypted.length);
  return command;
}
