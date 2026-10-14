import { xorPayload } from './mask.js';
import { modbusCrc } from './crc.js';

/** Antwoordt lokaal op PING of bevestigt bekende datarecords; input: gevalideerd frame; output: antwoord-Buffer of null. */
export function localReply(frame) {
  const kind = frame[7];
  if (kind === 0x16) return Buffer.from(frame); // Grott-protocol: ping wordt ge-echo'd.
  if (![0x03, 0x04, 0x29, 0x50].includes(kind) || frame.length <= 9) return null;
  const plain = Buffer.alloc(9);
  frame.copy(plain, 0, 0, 4); // Zelfde volgnummer/protocol, nooit externe data.
  plain.writeUInt16BE(3, 4);
  frame.copy(plain, 6, 6, 8);
  plain[8] = 0;
  if (frame[3] === 2) return plain;
  const encrypted = xorPayload(plain);
  const reply = Buffer.alloc(encrypted.length + 2);
  encrypted.copy(reply);
  reply.writeUInt16BE(modbusCrc(encrypted), encrypted.length);
  return reply;
}
