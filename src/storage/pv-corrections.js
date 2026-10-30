import { clockQuarter } from '../pv/quarter.js';

/** Bewaart onafhankelijke blokcorrecties en selecteert hun referenties per klokkwartier; input: SQLite; output: opslagmethoden los van diagnostische logs. */
export function createPvCorrectionStore(db) {
  const save = db.prepare(`INSERT INTO pv_correction_pattern(model_key,quarter_minute,factor,predicted_w,measured_w,measured_ms,updated_ms,signature,sampling_json)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(model_key,quarter_minute) DO UPDATE SET factor=excluded.factor,predicted_w=excluded.predicted_w,
    measured_w=excluded.measured_w,measured_ms=excluded.measured_ms,updated_ms=excluded.updated_ms,signature=excluded.signature,sampling_json=excluded.sampling_json
    WHERE excluded.measured_ms>=pv_correction_pattern.measured_ms AND excluded.updated_ms>=pv_correction_pattern.updated_ms
      AND excluded.signature<>pv_correction_pattern.signature`);
  const saveBlock = db.prepare(`INSERT INTO pv_block_corrections(model_key,start_ms,end_ms,factor,predicted_w,measured_w,measured_ms,updated_ms,signature,sampling_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_key,start_ms,end_ms) DO UPDATE SET factor=excluded.factor,predicted_w=excluded.predicted_w,
    measured_w=excluded.measured_w,measured_ms=excluded.measured_ms,updated_ms=excluded.updated_ms,signature=excluded.signature,sampling_json=excluded.sampling_json
    WHERE excluded.measured_ms>=pv_block_corrections.measured_ms AND excluded.updated_ms>=pv_block_corrections.updated_ms
      AND excluded.signature<>pv_block_corrections.signature`);
  return {
    /** Leest het klokpatroon voor één paneelmodel; input: modelhash; output: maximaal 96 kwartieren op klokvolgorde. */
    pvCorrectionPattern(modelKey) { return db.prepare('SELECT * FROM pv_correction_pattern WHERE model_key=? ORDER BY quarter_minute').all(modelKey); },
    /** Overschrijft een kwartier met een nieuwere correctie; input: volledige correctierij; output: SQLite-resultaat, een herhaalde identieke meting wijzigt niets. */
    savePvCorrection(row) { return save.run(row.model_key, row.quarter_minute, row.factor, row.predicted_w, row.measured_w, row.measured_ms, row.updated_ms, row.signature, row.sampling_json ?? null); },
    /** Leest gedateerde correcties binnen een tijdvenster; input: modelhash, begin/einde; output: chronologische blokken. */
    pvBlockCorrections(modelKey, from = -Infinity, to = Infinity) {
      return db.prepare('SELECT * FROM pv_block_corrections WHERE model_key=? AND end_ms>? AND start_ms<? ORDER BY end_ms').all(modelKey, from, to);
    },
    /** Leest uitsluitend het exact bedoelde kwartier; input: modelhash en eindtijd; output: correctierij of undefined. */
    pvBlockCorrection(modelKey, end) { return db.prepare('SELECT * FROM pv_block_corrections WHERE model_key=? AND end_ms=?').get(modelKey, end); },
    /** Kiest de nieuwste gemeten dag per Nederlands klokkwartier; input: modelhash, peiltijd en optionele exclusieve grens voor de blokstart; output: maximaal 96 lichte referenties zonder historische weer-/groepswaarden. */
    pvBlockCorrectionPattern(modelKey, now, beforeStart = Infinity) {
      const byQuarter = new Map();
      const rows = db.prepare(`SELECT start_ms,end_ms,factor,predicted_w,measured_w,measured_ms,updated_ms FROM pv_block_corrections
        WHERE model_key=? AND end_ms<=? AND measured_ms<=? AND updated_ms<=? AND start_ms<? ORDER BY end_ms DESC`).iterate(modelKey, now, now, now, beforeStart);
      for (const row of rows) {
        const quarter = clockQuarter(row.end_ms);
        if (!byQuarter.has(quarter)) byQuarter.set(quarter, { ...row, quarter_minute: quarter });
        if (byQuarter.size === 96) break;
      }
      return [...byQuarter.values()];
    },
    /** Leest de laatste beschikbare gedateerde correctie; input: modelhash en peiltijd; output: correctierij of undefined. */
    latestPvBlockCorrection(modelKey, now) {
      return db.prepare('SELECT * FROM pv_block_corrections WHERE model_key=? AND end_ms<=? AND measured_ms<=? AND updated_ms<=? ORDER BY end_ms DESC LIMIT 1').get(modelKey, now, now, now);
    },
    /** Telt opgeslagen onafhankelijke blokken; input: modelhash en peiltijd; output: aantal. */
    countPvBlockCorrections(modelKey, now) {
      return db.prepare('SELECT COUNT(*) AS count FROM pv_block_corrections WHERE model_key=? AND end_ms<=? AND measured_ms<=? AND updated_ms<=?').get(modelKey, now, now, now).count;
    },
    /** Bewaart alleen dit gedateerde kwartier; input: correctierij; output: SQLite-resultaat. */
    savePvBlockCorrection(row) {
      return saveBlock.run(row.model_key, row.start_ms, row.end_ms, row.factor, row.predicted_w, row.measured_w, row.measured_ms,
        row.updated_ms, row.signature, row.sampling_json ?? null);
    }
  };
}
