import { modbusCrc } from './crc.js';

/** Leest complete Growatt-frames uit een TCP-stroom; input: onvolledig Buffer en nieuwe Buffer; output: {frames,remainder}. */
export function splitFrames(remainder, chunk) {
  let data = Buffer.concat([remainder, chunk]);
  const frames = [];
  if (data.length > 131072) throw new Error('Growatt-buffer te groot');
  while (data.length >= 8) {
    const payloadLength = data.readUInt16BE(4);
    const version = data[3];
    const size = 6 + payloadLength + (version === 2 ? 0 : 2);
    if (payloadLength < 2 || size > 8192) throw new Error('Ongeldige Growatt-framelengte');
    if (data.length < size) break;
    frames.push(data.subarray(0, size));
    data = data.subarray(size);
  }
  return { frames, remainder: data };
}

/** Controleert header en CRC voordat er gegevens worden gebruikt; input: complete frame; output: {ok,reason,version,type}. */
export function validateFrame(frame) {
  const version = frame[3];
  const type = frame.subarray(6, 8).toString('hex');
  if (![2, 5, 6].includes(version)) return { ok: false, reason: 'unsupported_protocol', version, type };
  const size = 6 + frame.readUInt16BE(4) + (version === 2 ? 0 : 2);
  if (frame.length !== size) return { ok: false, reason: 'bad_length', version, type };
  if (version !== 2 && modbusCrc(frame.subarray(0, -2)) !== frame.readUInt16BE(frame.length - 2)) return { ok: false, reason: 'bad_crc', version, type };
  return { ok: true, reason: 'valid', version, type };
}
