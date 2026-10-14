import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { openDatabase } from '../src/storage/database.js';
import { createRepository } from '../src/storage/repository.js';
import { modbusCrc } from '../src/growatt/crc.js';
import { xorPayload } from '../src/growatt/mask.js';
import { splitFrames, validateFrame } from '../src/growatt/frame-reader.js';
import { decodeRecord, parseDeviceTime } from '../src/growatt/decode-record.js';
import { localReply } from '../src/growatt/protocol-replies.js';
import { startGrowattServer } from '../src/growatt/tcp-listener.js';

/** Bouwt een testpakket met Grott's bekende generieke v06-offsets; input: geen; output: geldige versleutelde Buffer. */
function fixture() {
  const plain = Buffer.alloc(170);
  plain.writeUInt16BE(1, 0);
  plain[3] = 6;
  plain.writeUInt16BE(plain.length - 6, 4);
  plain[6] = 0x51;
  plain[7] = 0x04;
  plain.write('TEST123456', 38, 'ascii');
  Buffer.from([26, 10, 14, 12, 0, 0]).copy(plain, 68);
  plain.writeInt32BE(12345, 101);
  plain.writeUInt32BE(25, 131);
  plain.writeUInt32BE(1000, 135);
  const encrypted = xorPayload(plain);
  const frame = Buffer.alloc(encrypted.length + 2);
  encrypted.copy(frame);
  frame.writeUInt16BE(modbusCrc(encrypted), encrypted.length);
  return frame;
}

test('fragmentatie/coalescentie, CRC, MIC-layout en lokale ACK', () => {
  const frame = fixture();
  let split = splitFrames(Buffer.alloc(0), frame.subarray(0, 17));
  assert.equal(split.frames.length, 0);
  split = splitFrames(split.remainder, Buffer.concat([frame.subarray(17), frame]));
  assert.equal(split.frames.length, 2);
  assert.equal(split.remainder.length, 0);
  assert.equal(validateFrame(frame).ok, true);
  const corrupted = Buffer.from(frame); corrupted[42] ^= 2;
  assert.equal(validateFrame(corrupted).reason, 'bad_crc');
  const receivedAt = Date.UTC(2026, 9, 14, 10, 5);
  const decoded = decodeRecord(frame, '/this/layout/does/not/exist', receivedAt);
  assert.equal(decoded.serial, 'TEST123456');
  assert.equal(decoded.measured_ms, Date.UTC(2026, 9, 14, 10));
  assert.equal(decoded.power_w, 1234.5);
  assert.equal(decoded.energy_today_kwh, 2.5);
  const reply = localReply(frame);
  assert.equal(validateFrame(reply).ok, true);
  assert.equal(reply[7], 4);
  assert.equal(reply.readUInt16BE(4), 3);
  assert.equal(parseDeviceTime(Buffer.from([26, 10, 14, 12, 0, 0]), receivedAt), Date.UTC(2026, 9, 14, 10));
});

test('TCP-ontvanger slaat echt verzonden frame op en antwoordt lokaal', async () => {
  const db = openDatabase(':memory:');
  const repository = createRepository(db);
  const server = startGrowattServer({ host: '127.0.0.1', port: 0 }, repository);
  await once(server, 'listening');
  const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
  await once(socket, 'connect');
  const data = once(socket, 'data');
  const frame = fixture();
  socket.write(frame.subarray(0, 30));
  socket.write(frame.subarray(30));
  const [reply] = await data;
  assert.equal(validateFrame(reply).ok, true);
  assert.equal(repository.currentInverters()[0].power_w, 1234.5);
  assert.match(repository.frameStatus()[0].status, /decoded/);
  socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  db.close();
});
