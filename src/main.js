import { join } from 'node:path';
import { loadConfiguration, root } from './config/load.js';
import { openDatabase } from './storage/database.js';
import { createRepository } from './storage/repository.js';
import { createBackupJob } from './storage/backup.js';
import { createWeatherScheduler } from './weather/scheduler.js';
import { createHomeWizardPoller } from './homewizard/poller.js';
import { startGrowattServer, stopGrowattServer } from './growatt/tcp-listener.js';
import { startHttpServer } from './api/http-server.js';

/** Verbindt afzonderlijke modules tot één lokale dienst; input: geen; output: gestart proces of fout. */
function main() {
  const { settings, panels, panel_errors: panelErrors } = loadConfiguration();
  const db = openDatabase(join(root, 'data/zonapi.sqlite'));
  const repository = createRepository(db);
  const weather = createWeatherScheduler({ settings, panels, panelErrors, repository });
  const homewizard = createHomeWizardPoller(settings, repository);
  const backups = createBackupJob(db, join(root, 'data'));
  const growatt = startGrowattServer(settings.growatt, repository);
  const growattRuntime = { server: growatt, last_error: null };
  const http = startHttpServer({ settings, panels, panelErrors, repository, weather, homewizard, growattRuntime });
  growatt.on('listening', () => console.log(`Growatt TCP luistert op ${settings.growatt.host}:${growatt.address().port}`));
  http.on('listening', () => console.log(`ZonAPI luistert op http://${settings.http.host}:${http.address().port}`));
  growatt.on('error', (error) => {
    growattRuntime.last_error = { code: error.code ?? null, message: error.message, at: new Date().toISOString() };
    repository.saveGrowattEvent(Date.now(), settings.growatt.host, 'listener_error', error.message);
    console.error('Growatt TCP:', error);
    process.exitCode = 1;
  });
  http.on('error', (error) => { console.error('HTTP:', error); process.exitCode = 1; });
  weather.start();
  homewizard.start();
  backups.start();
  process.once('SIGTERM', () => { void stop().catch((error) => console.error('Afsluiten:', error)); });
  process.once('SIGINT', () => { void stop().catch((error) => console.error('Afsluiten:', error)); });

  let stopping = false;
  /** Sluit sockets en listeners voor de database; input: geen; output: Promise<void>. */
  async function stop() {
    if (stopping) return;
    stopping = true;
    weather.stop(); homewizard.stop(); backups.stop();
    await Promise.all([new Promise((resolve) => http.close(resolve)), stopGrowattServer(growatt)]);
    db.close();
  }
}

main();
