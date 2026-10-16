import { join } from 'node:path';
import { loadConfiguration, root } from './config/load.js';
import { openDatabase } from './storage/database.js';
import { createRepository } from './storage/repository.js';
import { createBackupJob } from './storage/backup.js';
import { refreshPvForecast } from './pv/refresh-forecast.js';
import { createWeatherScheduler } from './weather/scheduler.js';
import { createHomeWizardPoller } from './homewizard/poller.js';
import { startGrowattServer, stopGrowattServer } from './growatt/tcp-listener.js';
import { startHttpServer } from './api/http-server.js';
import { createGrowattCloudPoller } from './growatt/cloud/poller.js';
import { growattCloudConfig } from './growatt/cloud/config.js';
import { repairGrowattCloudTime } from './storage/repair-growatt-cloud-time.js';
import { learnPvCorrection } from './pv/learn-correction.js';
import { currentProductionRows } from './production/source.js';

/** Verbindt afzonderlijke modules tot één lokale dienst; input: geen; output: gestart proces of fout. */
function main() {
  const { settings, panels, panel_errors: panelErrors } = loadConfiguration();
  const db = openDatabase(join(root, 'data/zonapi.sqlite'));
  const cloudConfig = growattCloudConfig(settings);
  const corrected = repairGrowattCloudTime(db, cloudConfig.timezone, cloudConfig.device_type);
  if (corrected) console.log(`Growatt: meettijd van ${corrected} cloudmetingen hersteld`);
  const repository = createRepository(db, settings.logging);
  refreshPvForecast(repository, settings, panels, panelErrors, Date.now());
  const weather = createWeatherScheduler({ settings, panels, panelErrors, repository });
  const homewizard = createHomeWizardPoller(settings, repository);
  const backups = createBackupJob(db, join(root, 'data'));
  /** Leert na een lokale meting uit de geselecteerde volledige installatie; input: meting en ontvangsttijd; output: void. */
  function correctLocalForecast(measurement, at) {
    if (cloudConfig.source !== 'cloud') learnPvCorrection(repository, settings, panels, panelErrors, currentProductionRows(repository, settings, at), at);
  }

  /** Leert na een complete cloudcyclus uit de geselecteerde bron; input: cyclusmetingen en ontvangsttijd; output: correctiestatus. */
  function correctCloudForecast(rows, at) {
    return learnPvCorrection(repository, settings, panels, panelErrors, cloudConfig.source === 'auto' ? currentProductionRows(repository, settings, at) : rows, at);
  }

  const growatt = startGrowattServer(settings.growatt, repository, correctLocalForecast);
  const growattRuntime = { server: growatt, last_error: null };
  const growattCloud = createGrowattCloudPoller({ settings, panels, repository, onMeasurements: correctCloudForecast });
  const http = startHttpServer({ settings, panels, panelErrors, repository, weather, homewizard, growattRuntime, growattCloud });
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
  growattCloud.start();
  backups.start();
  process.once('SIGTERM', () => { void stop().catch((error) => console.error('Afsluiten:', error)); });
  process.once('SIGINT', () => { void stop().catch((error) => console.error('Afsluiten:', error)); });

  let stopping = false;
  /** Sluit sockets en listeners voor de database; input: geen; output: Promise<void>. */
  async function stop() {
    if (stopping) return;
    stopping = true;
    weather.stop(); homewizard.stop(); backups.stop();
    await Promise.all([growattCloud.stop(), new Promise((resolve) => http.close(resolve)), stopGrowattServer(growatt)]);
    db.close();
  }
}

main();
