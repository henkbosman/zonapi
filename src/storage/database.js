import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPvCorrectionSchema } from './pv-correction-schema.js';
import { createApplianceCycleSchema } from './appliance-cycles.js';

/** Opent SQLite en maakt het lokale schema; input: databasepad; output: open DatabaseSync. */
export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 7) { db.close(); throw new Error('Database heeft een nieuwere schemaversie'); }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS forecast (
      source TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      ghi REAL NOT NULL, dni REAL NOT NULL, dhi REAL NOT NULL, fetched_ms INTEGER NOT NULL,
      PRIMARY KEY(start_ms, end_ms)
    );
    CREATE INDEX IF NOT EXISTS forecast_end ON forecast(end_ms);
    CREATE TABLE IF NOT EXISTS pv_forecast (
      group_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      source TEXT NOT NULL, power_w REAL NOT NULL CHECK(power_w>=0), gti_w_m2 REAL NOT NULL, fetched_ms INTEGER NOT NULL,
      model TEXT, base_power_w REAL CHECK(base_power_w IS NULL OR base_power_w>=0),
      correction_factor REAL NOT NULL DEFAULT 1 CHECK(correction_factor>=0 AND correction_factor<=10),
      computed_ms INTEGER NOT NULL DEFAULT 0 CHECK(computed_ms>=0),
      model_key TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(group_id, start_ms, end_ms), CHECK(end_ms>start_ms)
    );
    CREATE TABLE IF NOT EXISTS sun_times (
      local_date TEXT PRIMARY KEY, sunrise_ms INTEGER NOT NULL, sunset_ms INTEGER NOT NULL,
      source TEXT NOT NULL, fetched_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weather_calls (
      id INTEGER PRIMARY KEY, local_date TEXT NOT NULL, attempted_ms INTEGER NOT NULL,
      status TEXT NOT NULL, detail TEXT, source TEXT, request_url TEXT,
      http_status INTEGER, duration_ms INTEGER, forecast_rows INTEGER, sun_days INTEGER
    );
    CREATE INDEX IF NOT EXISTS weather_calls_date ON weather_calls(local_date);
    CREATE TABLE IF NOT EXISTS growatt_frames (
      id INTEGER PRIMARY KEY, received_ms INTEGER NOT NULL, peer TEXT NOT NULL,
      protocol INTEGER, record_type TEXT, status TEXT NOT NULL, raw BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS growatt_frame_type ON growatt_frames(record_type,id);
    CREATE TABLE IF NOT EXISTS growatt_events (
      id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, peer TEXT NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inverter_measurements (
      serial TEXT NOT NULL, measured_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      power_w REAL NOT NULL, energy_today_kwh REAL, energy_total_kwh REAL,
      frame_id INTEGER REFERENCES growatt_frames(id) ON DELETE SET NULL,
      PRIMARY KEY(serial, measured_ms)
    );
    CREATE INDEX IF NOT EXISTS inverter_received ON inverter_measurements(serial, received_ms);
    CREATE TABLE IF NOT EXISTS cloud_inverter_measurements (
      serial TEXT NOT NULL, measured_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      power_w REAL NOT NULL, energy_today_kwh REAL, energy_total_kwh REAL,
      PRIMARY KEY(serial, measured_ms)
    );
    CREATE INDEX IF NOT EXISTS cloud_inverter_time ON cloud_inverter_measurements(measured_ms);
    CREATE TABLE IF NOT EXISTS growatt_cloud_calls (
      id INTEGER PRIMARY KEY, attempted_ms INTEGER NOT NULL, method TEXT NOT NULL,
      request_url TEXT NOT NULL, device_serial TEXT, status TEXT NOT NULL,
      http_status INTEGER, duration_ms INTEGER NOT NULL, detail TEXT, response_json TEXT
    );
    CREATE TABLE IF NOT EXISTS meter_measurements (
      device TEXT NOT NULL, measured_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      net_power_w REAL NOT NULL, import_kwh REAL, export_kwh REAL,
      PRIMARY KEY(device, measured_ms)
    );
    CREATE INDEX IF NOT EXISTS meter_received ON meter_measurements(device, received_ms);
    CREATE TABLE IF NOT EXISTS diagnostic_settings (source TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS diagnostic_state (source TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(source,name));
    CREATE TABLE IF NOT EXISTS weather_conditions (
      location_key TEXT NOT NULL, time_ms INTEGER NOT NULL, source TEXT NOT NULL, model TEXT,
      cloud_cover REAL CHECK(cloud_cover IS NULL OR (cloud_cover>=0 AND cloud_cover<=100)),
      weather_code INTEGER CHECK(weather_code IS NULL OR (weather_code>=0 AND weather_code<=99)), fetched_ms INTEGER NOT NULL,
      PRIMARY KEY(location_key,time_ms)
    );
    CREATE TABLE IF NOT EXISTS pv_correction_candidates (
      model_key TEXT NOT NULL, end_ms INTEGER NOT NULL, created_ms INTEGER NOT NULL, ready_ms INTEGER NOT NULL,
      signature TEXT NOT NULL, candidate_json TEXT NOT NULL, PRIMARY KEY(model_key,end_ms)
    );
    CREATE TABLE IF NOT EXISTS weather_usage (local_date TEXT PRIMARY KEY, attempts INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS homewizard_calls (
      id INTEGER PRIMARY KEY, attempted_ms INTEGER NOT NULL, device TEXT NOT NULL, status TEXT NOT NULL,
      request_url TEXT NOT NULL, duration_ms INTEGER NOT NULL, detail TEXT, measurement TEXT
    );
    CREATE TABLE IF NOT EXISTS appliance_socket_state (
      appliance_id TEXT PRIMARY KEY, config_key TEXT NOT NULL, updated_ms INTEGER NOT NULL, state_json TEXT NOT NULL
    );
  `);
  // Bestaande weerhistorie behouden en nieuwe diagnosevelden toevoegen.
  const weatherColumns = new Set(db.prepare('PRAGMA table_info(weather_calls)').all().map((column) => column.name));
  for (const [name, type] of Object.entries({ source: 'TEXT', request_url: 'TEXT', http_status: 'INTEGER', duration_ms: 'INTEGER', forecast_rows: 'INTEGER', sun_days: 'INTEGER' })) {
    if (!weatherColumns.has(name)) db.exec(`ALTER TABLE weather_calls ADD COLUMN ${name} ${type}`);
  }
  for (const table of ['forecast', 'pv_forecast']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'model')) db.exec(`ALTER TABLE ${table} ADD COLUMN model TEXT`);
  }
  // Oude databases hadden een verplichte frame_id; historische metingen moeten bij het wissen van ruwe berichten blijven bestaan.
  const oldFrameColumn = db.prepare('PRAGMA table_info(inverter_measurements)').all().find((column) => column.name === 'frame_id');
  if (oldFrameColumn?.notnull) {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE inverter_measurements_updated (
        serial TEXT NOT NULL, measured_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
        power_w REAL NOT NULL, energy_today_kwh REAL, energy_total_kwh REAL,
        frame_id INTEGER REFERENCES growatt_frames(id) ON DELETE SET NULL,
        PRIMARY KEY(serial, measured_ms)
      );
      INSERT INTO inverter_measurements_updated SELECT * FROM inverter_measurements;
      DROP TABLE inverter_measurements;
      ALTER TABLE inverter_measurements_updated RENAME TO inverter_measurements;
      CREATE INDEX inverter_received ON inverter_measurements(serial, received_ms);`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS inverter_frame ON inverter_measurements(frame_id);
    INSERT OR IGNORE INTO weather_usage SELECT local_date,COUNT(*) FROM weather_calls GROUP BY local_date;`);
  // Eenmalige overdracht van huidige status uit bestaande weerlogs.
  for (const [key, condition] of [['last_call', ''], ['last_success', "WHERE status='ok'"]]) {
    const previous = db.prepare(`SELECT * FROM weather_calls ${condition} ORDER BY attempted_ms DESC,id DESC LIMIT 1`).get();
    if (previous) db.prepare("INSERT OR IGNORE INTO diagnostic_state VALUES('weather',?,?)").run(key, JSON.stringify(previous));
  }
  createPvCorrectionSchema(db, { migratePerBlock: version < 6 });
  createApplianceCycleSchema(db);
  db.exec('PRAGMA user_version=7');
  return db;
}
