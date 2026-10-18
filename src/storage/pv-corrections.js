/** Bewaart één actuele correctie per model en klokkwartier; input: SQLite; output: lees- en overschrijfmethoden zonder koppeling aan diagnostische logs. */
export function createPvCorrectionStore(db) {
  const save = db.prepare(`INSERT INTO pv_correction_pattern(model_key,quarter_minute,factor,predicted_w,measured_w,measured_ms,updated_ms,signature,sampling_json)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(model_key,quarter_minute) DO UPDATE SET factor=excluded.factor,predicted_w=excluded.predicted_w,
    measured_w=excluded.measured_w,measured_ms=excluded.measured_ms,updated_ms=excluded.updated_ms,signature=excluded.signature,sampling_json=excluded.sampling_json
    WHERE excluded.measured_ms>=pv_correction_pattern.measured_ms AND excluded.updated_ms>=pv_correction_pattern.updated_ms
      AND excluded.signature<>pv_correction_pattern.signature`);
  return {
    /** Leest het klokpatroon voor één paneelmodel; input: modelhash; output: maximaal 96 kwartieren op klokvolgorde. */
    pvCorrectionPattern(modelKey) { return db.prepare('SELECT * FROM pv_correction_pattern WHERE model_key=? ORDER BY quarter_minute').all(modelKey); },
    /** Overschrijft een kwartier met een nieuwere correctie; input: volledige correctierij; output: SQLite-resultaat, een herhaalde identieke meting wijzigt niets. */
    savePvCorrection(row) { return save.run(row.model_key, row.quarter_minute, row.factor, row.predicted_w, row.measured_w, row.measured_ms, row.updated_ms, row.signature, row.sampling_json ?? null); }
  };
}
