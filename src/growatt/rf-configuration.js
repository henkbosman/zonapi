import { xorPayload } from './mask.js';
import { readSerial } from './decode-record.js';
import { validateFrame } from './frame-reader.js';

/** Leest de registerlijst van een ShineLanBox xx29-pakket; input: compleet gevalideerd v06-frame; output: RF-identiteit en registerwaarden of null. */
export function decodeRfConfiguration(frame) {
  if (frame[3] !== 6 || frame[7] !== 0x29 || frame.length < 104 || !validateFrame(frame).ok) return null;
  const plain = xorPayload(frame.subarray(0, -2));
  const dataloggerSerial = readSerial(plain, 8);
  const rfSerial = readSerial(plain, 38);
  const inverterSerial = readSerial(plain, 68);
  if (!dataloggerSerial || !rfSerial || !inverterSerial) return null;
  const registers = {};
  let offset = 100;
  while (offset < plain.length) {
    if (offset + 4 > plain.length) return null;
    const key = plain.readUInt16BE(offset);
    const length = plain.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > plain.length) return null;
    registers[key] = plain.subarray(offset, offset + length).toString('ascii').replace(/\0+$/, '');
    offset += length;
  }
  return {
    address: frame[6].toString(16).padStart(2, '0').toUpperCase(),
    datalogger_serial: dataloggerSerial,
    rf_serial: rfSerial,
    inverter_serial: inverterSerial,
    update_interval_minutes: /^\d+(?:\.\d+)?$/.test(registers[4] ?? '') ? Number(registers[4]) : null,
    firmware: registers[21] ?? null,
    timezone: registers[30] ?? null,
    device_time: registers[31] ?? null,
    registers
  };
}
