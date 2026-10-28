import { learnQuarterCorrection } from './learn-quarter-correction.js';
import { correctionModelKey } from './correction-key.js';
import { currentProductionRows } from '../production/source.js';
import { checkClearSky } from '../weather/clear-sky.js';
import { publishPvCorrection } from './learn-correction.js';
import { automaticCorrectionConfig } from './automatic-config.js';
import { localDay } from '../weather/local-day.js';
import { localDayRange } from '../weather/local-calendar.js';

/** Bepaalt het einde van de Nederlandse meetdag, ook voor 23:45–00:00 en zomer-/wintertijd; input: kwartiereinde; output: eerst toegestane rekentijd in epoch-ms. */
function dayEnd(end) { return localDayRange(localDay(end - 900000)).end_ms; }

/** Bewaart verse meetdrietallen en berekent hun onafhankelijke factoren na afloop van de Nederlandse meetdag; input: instellingen, paneelmodel, opslag en optionele klok; output: leerfunctie en zelfstandige dagafsluiting met hervatting na herstart. */
export function createPvCorrectionLearner({ settings, panels, panelErrors, repository, clock = () => Date.now() }) {
  let interval = null;
  /** Leert uit de gekozen bron of expliciete ronde en bewaart de reden als leren nog niet kan; input: optionele rijen en peiltijd; output: correctieresultaat. */
  function learn(rows = null, now = clock()) {
    let result;
    try {
      const captured = learnQuarterCorrection(repository, settings, panels, panelErrors, rows ?? currentProductionRows(repository, settings, now), now, { defer: true });
      result = captured;
      if (!['disabled', 'configuration_incomplete'].includes(captured.status)) {
        repository.pruneClearSkyHistory(now);
        const pending = repository.pvCorrectionCandidates(correctionModelKey(settings, panels), now);
        const maxCloudCoverPercent = automaticCorrectionConfig(settings).max_cloud_cover_percent;
        const applied = [];
        let waiting = null, waitingForDay = null;
        for (const item of pending) {
          const ready = dayEnd(item.end_ms);
          if (now < ready) {
            waitingForDay ??= { status: 'waiting_for_day_end', target_time: new Date(item.end_ms).toISOString(), ready_at: new Date(ready).toISOString() };
            continue;
          }
          const clearSky = checkClearSky(repository, settings.location, item.end_ms, now, maxCloudCoverPercent);
          if (clearSky.status !== 'clear') {
            waiting = { status: clearSky.status, target_time: new Date(item.end_ms).toISOString(), clear_sky: clearSky };
            continue;
          }
          applied.push(publishPvCorrection(repository, settings, panels, panelErrors, JSON.parse(item.candidate_json), now, clearSky));
        }
        result = { ...(applied.at(-1) ?? waiting ?? waitingForDay ?? captured), processed_count: applied.length,
          pending_count: repository.pvCorrectionCandidates(correctionModelKey(settings, panels), now).length };
      }
    } catch (error) {
      result = { status: 'error', message: String(error.message ?? error).slice(0, 500) };
      repository.saveGrowattEvent(now, 'pv-correction', 'forecast_correction_error', result.message);
    }
    const { sampling, ...attempt } = result;
    repository.saveDiagnosticState('growatt', 'pv_correction', { ...attempt, attempted_at: new Date(now).toISOString(),
      model_key: correctionModelKey(settings, panels), ...(sampling ? { used_samples: sampling.used_samples } : {}) });
    return result;
  }
  /** Verwerkt afgesloten meetdagen zonder actuele Growatt-data of extra weerverzoek; input: geen; output: correctieresultaat of null zolang geen dag klaarstaat. */
  function tick() {
    const now = clock(), start = localDayRange(localDay(now)).start_ms;
    if (!repository.pvCorrectionCandidates(correctionModelKey(settings, panels), now).some((item) => item.end_ms - 900000 < start)) return null;
    return learn([], now);
  }

  /** Start eenmaal de hervatting en minuutcontrole op afgesloten dagen; input: geen; output: void. */
  function start() {
    if (interval !== null) return;
    learn();
    interval = setInterval(tick, 60000);
  }

  /** Stopt de dagafsluiting vóór het sluiten van de database; input: geen; output: void. */
  function stop() { clearInterval(interval); interval = null; }
  return { learn, tick, start, stop };
}
