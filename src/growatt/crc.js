/** Berekent Modbus CRC16 als getal; input: Buffer/Uint8Array zonder CRC; output: 0..65535. */
export function modbusCrc(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}
