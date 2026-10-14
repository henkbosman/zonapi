import net from 'node:net';
import { join } from 'node:path';
import { root } from '../config/load.js';
import { splitFrames, validateFrame } from './frame-reader.js';
import { decodeRecord } from './decode-record.js';
import { decodeAnnouncement } from './announcement.js';
import { localReply } from './protocol-replies.js';

const activeGrowattSockets = new WeakMap();

/** Start uitsluitend een lokale TCP-ontvanger; input: Growatt-config, repository; output: luisterende net.Server. */
export function startGrowattServer(config, repository) {
  const layoutDir = join(root, 'config/layouts');
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    let rest = Buffer.alloc(0);
    let framesReceived = 0;
    let repliesQueued = 0;
    let endedByServer = false;
    const peer = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
    const idleMinutes = config.idle_timeout_minutes ?? 30;
    repository.saveGrowattEvent(Date.now(), peer, 'connected', 'TCP');
    socket.setKeepAlive(true, 60000);
    socket.setTimeout(idleMinutes * 60000);
    socket.on('timeout', () => {
      endedByServer = true;
      const detail = rest.length ? `${rest.length} bytes ontvangen; ${idleMinutes} min geen nieuwe data` : `${idleMinutes} min geen data; ${framesReceived} pakketten, ${repliesQueued} antwoorden`;
      repository.saveGrowattEvent(Date.now(), peer, rest.length ? 'incomplete_timeout' : 'idle_disconnect', detail);
      socket.destroy();
    });
    socket.on('error', (error) => {
      repository.saveGrowattEvent(Date.now(), peer, 'socket_error', error.message);
      console.error('Growatt TCP:', error.message);
    });
    socket.on('close', () => {
      clients.delete(socket);
      if (endedByServer || !server.listening) return;
      if (rest.length) repository.saveGrowattEvent(Date.now(), peer, 'incomplete_frame', `${rest.length} bytes ontvangen voordat de verbinding sloot`);
      repository.saveGrowattEvent(Date.now(), peer, 'disconnected', `${framesReceived} pakketten, ${repliesQueued} antwoorden`);
    });
    socket.on('data', (chunk) => {
      try {
        const split = splitFrames(rest, chunk);
        rest = split.remainder;
        for (const frame of split.frames) {
          framesReceived++;
          const at = Date.now();
          const checked = validateFrame(frame);
          const id = repository.saveFrame(at, peer, checked.version, checked.type, checked.reason, frame);
          if (!checked.ok) continue;
          const decoded = decodeRecord(frame, layoutDir, at);
          if (decoded) {
            repository.saveInverter({ ...decoded, frame_id: id });
            repository.markFrame(id, decoded.clock_fallback ? `decoded:${decoded.layout}:clock_fallback` : `decoded:${decoded.layout}`);
          } else if (decodeAnnouncement(frame)) repository.markFrame(id, 'announcement');
          else repository.markFrame(id, [0x04, 0x50].includes(frame[7]) ? 'unknown_layout' : 'control');
          const reply = localReply(frame);
          if (reply) { socket.write(reply); repliesQueued++; }
        }
      } catch (error) {
        endedByServer = true;
        repository.saveGrowattEvent(Date.now(), peer, 'frame_error', error.message);
        console.error('Growatt frame:', error.message);
        socket.destroy();
      }
    });
  });
  activeGrowattSockets.set(server, clients);
  server.listen(config.port, config.host);
  return server;
}

/** Sluit actieve ShineLanBox-verbindingen en daarna de listener; input: net.Server; output: Promise<void>. */
export function stopGrowattServer(server) {
  for (const socket of activeGrowattSockets.get(server) ?? []) socket.destroy();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
