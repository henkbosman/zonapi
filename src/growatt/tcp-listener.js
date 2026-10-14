import net from 'node:net';
import { join } from 'node:path';
import { root } from '../config/load.js';
import { splitFrames, validateFrame } from './frame-reader.js';
import { decodeRecord } from './decode-record.js';
import { decodeAnnouncement } from './announcement.js';
import { localReply } from './protocol-replies.js';
import { timeSyncCommand } from './time-sync.js';
import { createClockPolicy } from './clock-policy.js';

const activeGrowattSockets = new WeakMap();

/** Schrijft een lokaal protocolbericht en logt de socketuitkomst; input: socket, server, opslag, peer, pakket-id, soort, bytes, logsoort en optionele callback na succesvolle overdracht; output: void. */
function sendLocal(socket, server, repository, peer, frameId, type, bytes, eventKind, onWritten) {
  socket.write(bytes, (error) => {
    if (!server.listening) return;
    const detail = `${type} #${frameId} · ${bytes.length} bytes · ${bytes.toString('hex')}`;
    repository.saveGrowattEvent(Date.now(), peer, error ? (eventKind === 'reply_sent' ? 'reply_error' : 'time_sync_error') : eventKind, error ? `${detail} · ${error.message}` : detail);
    if (!error && !socket.destroyed) onWritten?.();
  });
}

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
    const clockPolicy = createClockPolicy(config.expected_inverters ?? 4, config.time_sync_retry_minutes ?? 10);
    const peer = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
    const idleMinutes = config.idle_timeout_minutes ?? 30;
    repository.saveGrowattEvent(Date.now(), peer, 'connected', 'TCP');
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
          if (frame[7] === 0x04 && frame[6] >= 0x50 && frame[6] <= 0x53) clockPolicy.receivedMeasurement(frame[6]);
          const preparedClock = config.time_sync_on_announcement !== false && frame[7] === 0x03 && frame[6] >= 0x50 && frame[6] <= 0x53
            ? timeSyncCommand(frame, at) : null;
          const command = preparedClock && clockPolicy.shouldSync(at) ? preparedClock : null;
          const reply = localReply(frame);
          if (reply) {
            // Schrijf de ACK voordat de decoder en meetopslag worden uitgevoerd.
            sendLocal(socket, server, repository, peer, id, checked.type, reply, 'reply_sent', command
              ? () => sendLocal(socket, server, repository, peer, id, '0118', command, 'time_sync_sent') : undefined);
            repliesQueued++;
          }
          if (frame[7] === 0x18) {
            repository.saveGrowattEvent(at, peer, 'time_sync_response', `${checked.type} #${id} · ${frame.length} bytes · ${frame.toString('hex')}`);
          }
          const decoded = decodeRecord(frame, layoutDir, at);
          if (decoded) {
            repository.saveInverter({ ...decoded, frame_id: id });
            repository.markFrame(id, decoded.clock_fallback ? `decoded:${decoded.layout}:clock_fallback` : `decoded:${decoded.layout}`);
          } else if (decodeAnnouncement(frame)) repository.markFrame(id, 'announcement');
          else repository.markFrame(id, [0x04, 0x50].includes(frame[7]) ? 'unknown_layout' : 'control');
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
