/** Maakt blokcorrecties, het patroonarchief en afgeleide metadata; input: SQLite en migratievlag; output: void met behoud van oorspronkelijke brongegevens. */
export function createPvCorrectionSchema(db, { migratePerBlock = false } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS pv_correction_pattern (
    model_key TEXT NOT NULL CHECK(length(model_key)=64),
    quarter_minute INTEGER NOT NULL CHECK(quarter_minute>=0 AND quarter_minute<1440 AND quarter_minute%15=0),
    factor REAL NOT NULL CHECK(factor>=0 AND factor<=10),
    predicted_w REAL NOT NULL CHECK(predicted_w>0), measured_w REAL NOT NULL CHECK(measured_w>=0),
    measured_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, signature TEXT NOT NULL,
    PRIMARY KEY(model_key,quarter_minute)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS pv_correction_latest ON pv_correction_pattern(model_key,measured_ms DESC);`);
  if (!db.prepare('PRAGMA table_info(pv_correction_pattern)').all().some((column) => column.name === 'sampling_json')) db.exec('ALTER TABLE pv_correction_pattern ADD COLUMN sampling_json TEXT');
  const columns = new Set(db.prepare('PRAGMA table_info(pv_forecast)').all().map((column) => column.name));
  for (const [name, type] of Object.entries({ base_power_w: 'REAL', correction_factor: 'REAL NOT NULL DEFAULT 1', computed_ms: 'INTEGER NOT NULL DEFAULT 0', model_key: "TEXT NOT NULL DEFAULT ''" })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE pv_forecast ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS pv_block_corrections (
    model_key TEXT NOT NULL CHECK(length(model_key)=64), start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
    factor REAL NOT NULL CHECK(factor>=0 AND factor<=10),
    predicted_w REAL NOT NULL CHECK(predicted_w>0), measured_w REAL NOT NULL CHECK(measured_w>=0),
    measured_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, signature TEXT NOT NULL, sampling_json TEXT,
    PRIMARY KEY(model_key,start_ms,end_ms), CHECK(end_ms-start_ms=900000), CHECK(end_ms%900000=0)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS pv_block_correction_latest ON pv_block_corrections(model_key,end_ms DESC);`);
  if (migratePerBlock) {
    db.exec('BEGIN');
    try {
      const insert = db.prepare(`INSERT OR IGNORE INTO pv_block_corrections
        (model_key,start_ms,end_ms,factor,predicted_w,measured_w,measured_ms,updated_ms,signature,sampling_json) VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const row of db.prepare('SELECT * FROM pv_correction_pattern WHERE sampling_json IS NOT NULL').all()) {
        let sampling;
        try { sampling = JSON.parse(row.sampling_json); } catch { continue; }
        const end = Date.parse(sampling?.target_time);
        if (!Number.isSafeInteger(end) || end % 900000 !== 0 || end > row.updated_ms) continue;
        insert.run(row.model_key, end - 900000, end, row.factor, row.predicted_w, row.measured_w, row.measured_ms,
          row.updated_ms, row.signature, row.sampling_json);
      }
      // Verwijder alleen afgeleide factoren die van een ander blok waren overgenomen.
      db.exec(`UPDATE pv_forecast AS pv SET power_w=COALESCE(base_power_w,power_w), correction_factor=1
        WHERE correction_factor<>1 AND NOT EXISTS (SELECT 1 FROM pv_block_corrections b
          WHERE b.model_key=pv.model_key AND b.start_ms=pv.start_ms AND b.end_ms=pv.end_ms AND b.factor=pv.correction_factor)`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.exec('PRAGMA user_version=3');
}
