import net from 'node:net';
import { join } from 'node:path';
import { root } from '../config/load.js';
import { splitFrames, validateFrame } from './frame-reader.js';
import { decodeRecord } from './decode-record.js';
import { localReply } from './protocol-replies.js';

/** Start uitsluitend een lokale TCP-ontvanger; input: Growatt-config, repository; output: luisterende net.Server. */
export function startGrowattServer(config, repository) {
  const layoutDir = join(root, 'config/layouts');
  const server = net.createServer((socket) => {
    let rest = Buffer.alloc(0);
    const peer = socket.remoteAddress ?? 'unknown';
    socket.setTimeout(120000);
    socket.on('timeout', () => {
      repository.saveGrowattEvent(Date.now(), peer, 'timeout', '120 s');
      socket.destroy();
    });
    socket.on('error', (error) => {
      repository.saveGrowattEvent(Date.now(), peer, 'socket_error', error.message);
      console.error('Growatt TCP:', error.message);
    });
    socket.on('data', (chunk) => {
      try {
        const split = splitFrames(rest, chunk);
        rest = split.remainder;
        for (const frame of split.frames) {
          const at = Date.now();
          const checked = validateFrame(frame);
          const id = repository.saveFrame(at, peer, checked.version, checked.type, checked.reason, frame);
          if (!checked.ok) continue;
          const decoded = decodeRecord(frame, layoutDir, at);
          if (decoded) {
            repository.saveInverter({ ...decoded, frame_id: id });
            repository.markFrame(id, decoded.clock_fallback ? `decoded:${decoded.layout}:clock_fallback` : `decoded:${decoded.layout}`);
          } else repository.markFrame(id, [0x04, 0x50].includes(frame[7]) ? 'unknown_layout' : 'control');
          const reply = localReply(frame);
          if (reply) socket.write(reply);
        }
      } catch (error) {
        repository.saveGrowattEvent(Date.now(), peer, 'frame_error', error.message);
        console.error('Growatt frame:', error.message);
        socket.destroy();
      }
    });
  });
  server.listen(config.port, config.host);
  return server;
}
