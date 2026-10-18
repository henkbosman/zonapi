import { learnQuarterCorrection } from './learn-quarter-correction.js';
import { correctionModelKey } from './correction-key.js';
import { currentProductionRows } from '../production/source.js';

/** Verbindt correcties met meetrondes, herstart en nieuwe weerdata; input: instellingen, paneelmodel, opslag en optionele klok; output: leerfunctie met bewaarde laatste poging. */
export function createPvCorrectionLearner({ settings, panels, panelErrors, repository, clock = () => Date.now() }) {
  /** Leert uit de gekozen bron of expliciete ronde en bewaart de reden als leren nog niet kan; input: optionele rijen en peiltijd; output: correctieresultaat. */
  function learn(rows = null, now = clock()) {
    let result;
    try {
      result = learnQuarterCorrection(repository, settings, panels, panelErrors, rows ?? currentProductionRows(repository, settings, now), now);
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
