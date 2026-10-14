const mask = Buffer.from('Growatt');

/** XOR't het payloaddeel van een Growatt-v05/06-frame; input: Buffer zonder CRC; output: nieuwe plaintext of versleutelde Buffer. */
export function xorPayload(frame) {
  const result = Buffer.from(frame);
  for (let i = 8; i < result.length; i++) result[i] ^= mask[(i - 8) % mask.length];
  return result;
}
