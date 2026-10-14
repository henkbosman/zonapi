import { xorPayload } from './mask.js';
import { readSerial } from './decode-record.js';
import { validateFrame } from './frame-reader.js';

/** Benoemt de soort van een Growatt-record; input: viercijferig hex-type; output: korte Nederlandse naam. */
export function recordLabel(type) {
  const kind = type?.slice(-2);
  return ({ '03': 'Aanmelding', '29': 'Aanmelding', '04': 'Meting', '50': 'Archief', '16': 'Ping' })[kind] ?? 'Overig';
}

/** Leest de serienummers uit een geldige ShineLanBox v06-aanmelding; input: compleet frame; output: adres, logger, omvormer en soort of null. */
export function decodeAnnouncement(frame) {
  if (frame[3] !== 6 || frame[6] < 0x50 || frame[6] > 0x53 || ![0x03, 0x29].includes(frame[7])) return null;
  if (validateFrame(frame).ok !== true) return null;
  const serialOffset = frame[7] === 0x03 ? 38 : 68;
  if (frame.length < serialOffset + 12) return null;
  const plain = xorPayload(frame.subarray(0, -2));
  const dataloggerSerial = readSerial(plain, 8);
  const inverterSerial = readSerial(plain, serialOffset);
  if (!dataloggerSerial || !inverterSerial) return null;
  return {
    address: frame[6].toString(16).padStart(2, '0').toUpperCase(),
    inverter_serial: inverterSerial,
    datalogger_serial: dataloggerSerial,
    record_type: frame.subarray(6, 8).toString('hex').toUpperCase()
  };
}
