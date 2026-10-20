import { learnQuarterCorrection } from './learn-quarter-correction.js';
import { correctionModelKey } from './correction-key.js';
import { currentProductionRows } from '../production/source.js';
import { checkClearSky } from '../weather/clear-sky.js';
import { publishPvCorrection } from './learn-correction.js';

/** Bewaart verse meetdrietallen en publiceert uitsluitend na de achteraf gecontroleerde onbewolkte uren; input: instellingen, paneelmodel, opslag en optionele klok; output: leerfunctie met blijvende wachtstatus en hervatting na herstart/weeropvraag. */
export function createPvCorrectionLearner({ settings, panels, panelErrors, repository, clock = () => Date.now() }) {
  /** Leert uit de gekozen bron of expliciete ronde en bewaart de reden als leren nog niet kan; input: optionele rijen en peiltijd; output: correctieresultaat. */
  function learn(rows = null, now = clock()) {
    let result;
    try {
      const captured = learnQuarterCorrection(repository, settings, panels, panelErrors, rows ?? currentProductionRows(repository, settings, now), now, { defer: true });
      result = captured;
      if (!['disabled', 'configuration_incomplete'].includes(captured.status)) {
        repository.pruneClearSkyHistory(now);
        const pending = repository.pvCorrectionCandidates(correctionModelKey(settings, panels), now);
        const applied = [];
        let waiting = null;
        for (const item of pending) {
          const clearSky = checkClearSky(repository, settings.location, item.end_ms, now);
          if (clearSky.status !== 'clear') {
            waiting = { status: clearSky.status, target_time: new Date(item.end_ms).toISOString(), clear_sky: clearSky };
            continue;
          }
          applied.push(publishPvCorrection(repository, settings, panels, panelErrors, JSON.parse(item.candidate_json), now, clearSky));
        }
        result = { ...(applied.at(-1) ?? waiting ?? captured), processed_count: applied.length,
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
  return { learn };
}
