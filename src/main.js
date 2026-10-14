import { join } from 'node:path';
import { loadConfiguration, root } from './config/load.js';
import { openDatabase } from './storage/database.js';
import { createRepository } from './storage/repository.js';
import { createBackupJob } from './storage/backup.js';
import { createWeatherScheduler } from './weather/scheduler.js';
import { createHomeWizardPoller } from './homewizard/poller.js';
import { startGrowattServer } from './growatt/tcp-listener.js';
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
  const http = startHttpServer({ settings, panels, panelErrors, repository, weather, homewizard });
  growatt.on('listening', () => console.log(`Growatt TCP luistert op ${settings.growatt.host}:${growatt.address().port}`));
  http.on('listening', () => console.log(`ZonAPI luistert op http://${settings.http.host}:${http.address().port}`));
  growatt.on('error', (error) => { console.error('Growatt TCP:', error); process.exitCode = 1; });
  http.on('error', (error) => { console.error('HTTP:', error); process.exitCode = 1; });
  weather.start();
  homewizard.start();
  backups.start();
  process.once('SIGTERM', () => stop());
  process.once('SIGINT', () => stop());

  /** Sluit listeners en geplande verzoeken bij stoppen; input: geen; output: void. */
  function stop() {
    weather.stop(); homewizard.stop(); backups.stop();
    http.close(); growatt.close();
    db.close();
  }
}

main();
