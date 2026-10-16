/** Maakt de kwartierpatronen en metadata voor afgeleide PV-waarden; input: SQLite; output: void, bestaande tabellen krijgen alleen ontbrekende kolommen. */
export function createPvCorrectionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pv_correction_pattern (
    model_key TEXT NOT NULL CHECK(length(model_key)=64),
    quarter_minute INTEGER NOT NULL CHECK(quarter_minute>=0 AND quarter_minute<1440 AND quarter_minute%15=0),
    factor REAL NOT NULL CHECK(factor>=0 AND factor<=10),
    predicted_w REAL NOT NULL CHECK(predicted_w>0), measured_w REAL NOT NULL CHECK(measured_w>=0),
    measured_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, signature TEXT NOT NULL,
    PRIMARY KEY(model_key,quarter_minute)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS pv_correction_latest ON pv_correction_pattern(model_key,measured_ms DESC);`);
  const columns = new Set(db.prepare('PRAGMA table_info(pv_forecast)').all().map((column) => column.name));
  for (const [name, type] of Object.entries({ base_power_w: 'REAL', correction_factor: 'REAL NOT NULL DEFAULT 1', computed_ms: 'INTEGER NOT NULL DEFAULT 0', model_key: "TEXT NOT NULL DEFAULT ''" })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE pv_forecast ADD COLUMN ${name} ${type}`);
  }
  db.exec('PRAGMA user_version=3');
}
