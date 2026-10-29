/** Maakt opslag voor bewolkingspunten en nog te beoordelen meetdrietallen; input: SQLite; output: methoden met locatie-/modelscheiding. */
export function createClearSkyStore(db) {
  const condition = db.prepare(`INSERT INTO weather_conditions(location_key,time_ms,source,model,cloud_cover,weather_code,fetched_ms)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(location_key,time_ms) DO UPDATE SET source=excluded.source,model=excluded.model,
      cloud_cover=excluded.cloud_cover,weather_code=excluded.weather_code,fetched_ms=excluded.fetched_ms
    WHERE excluded.fetched_ms>weather_conditions.fetched_ms`);
  const pending = db.prepare(`INSERT INTO pv_correction_candidates(model_key,end_ms,created_ms,ready_ms,signature,candidate_json)
    VALUES(?,?,?,?,?,?) ON CONFLICT(model_key,end_ms) DO UPDATE SET created_ms=excluded.created_ms,ready_ms=excluded.ready_ms,
      signature=excluded.signature,candidate_json=excluded.candidate_json
    WHERE excluded.created_ms>=pv_correction_candidates.created_ms AND excluded.signature<>pv_correction_candidates.signature`);
  return {
    /** Bewaart één modelpunt zonder ontbrekende waarden als nul te behandelen; input: locatie en bronpunt; output: SQLite-resultaat. */
    saveWeatherCondition(location, row) { return condition.run(location, row.time_ms, row.source, row.model ?? null,
      row.cloud_cover ?? null, row.weather_code ?? null, row.fetched_ms); },
    /** Leest oorspronkelijke bewolkingspunten; input: locatie en inclusieve tijdgrenzen; output: tijdgeordende modelpunten. */
    weatherConditions(location, from, to) {
      return db.prepare('SELECT * FROM weather_conditions WHERE location_key=? AND time_ms>=? AND time_ms<=? ORDER BY time_ms').all(location, from, to);
    },
    /** Bewaart een gevalideerd meetdrietal met zijn oorspronkelijke ongecorrigeerde basis; input: correctierij, ontvangsttijd en eerste controletijd; output: SQLite-resultaat. */
    savePvCorrectionCandidate(row, now, ready) { return pending.run(row.model_key, row.end_ms, now, ready, row.signature, JSON.stringify(row)); },
    /** Leest nog te beoordelen blokken voor het actieve model; input: modelhash en peiltijd; output: chronologische kandidaten. */
    pvCorrectionCandidates(modelKey, now) {
      return db.prepare('SELECT * FROM pv_correction_candidates WHERE model_key=? AND created_ms<=? ORDER BY end_ms').all(modelKey, now);
    },
    /** Verwijdert uitsluitend de verwerkte versie van een kandidaat; input: modelhash, blok en signatuur; output: SQLite-resultaat. */
    deletePvCorrectionCandidate(modelKey, end, signature) {
      return db.prepare('DELETE FROM pv_correction_candidates WHERE model_key=? AND end_ms=? AND signature=?').run(modelKey, end, signature);
    },
    /** Houdt maximaal twee dagen kandidaten en vier dagen bewolkingshistorie; input: peiltijd; output: void. */
    pruneClearSkyHistory(now) {
      db.prepare('DELETE FROM pv_correction_candidates WHERE end_ms<?').run(now - 48 * 3600000);
      db.prepare('DELETE FROM weather_conditions WHERE time_ms<?').run(now - 96 * 3600000);
    }
  };
}
