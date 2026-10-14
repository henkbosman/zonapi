import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Opent SQLite en maakt het lokale schema; input: databasepad; output: open DatabaseSync. */
export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS forecast (
      source TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      ghi REAL NOT NULL, dni REAL NOT NULL, dhi REAL NOT NULL, fetched_ms INTEGER NOT NULL,
      PRIMARY KEY(start_ms, end_ms)
    );
    CREATE INDEX IF NOT EXISTS forecast_end ON forecast(end_ms);
    CREATE TABLE IF NOT EXISTS pv_forecast (
      group_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      source TEXT NOT NULL, power_w REAL NOT NULL, gti_w_m2 REAL NOT NULL, fetched_ms INTEGER NOT NULL,
      PRIMARY KEY(group_id, start_ms, end_ms)
    );
    CREATE TABLE IF NOT EXISTS sun_times (
      local_date TEXT PRIMARY KEY, sunrise_ms INTEGER NOT NULL, sunset_ms INTEGER NOT NULL,
      source TEXT NOT NULL, fetched_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weather_calls (
      id INTEGER PRIMARY KEY, local_date TEXT NOT NULL, attempted_ms INTEGER NOT NULL,
      status TEXT NOT NULL, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS weather_calls_date ON weather_calls(local_date);
    CREATE TABLE IF NOT EXISTS growatt_frames (
      id INTEGER PRIMARY KEY, received_ms INTEGER NOT NULL, peer TEXT NOT NULL,
      protocol INTEGER, record_type TEXT, status TEXT NOT NULL, raw BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS growatt_events (
      id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, peer TEXT NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inverter_measurements (
      serial TEXT NOT NULL, measured_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      power_w REAL NOT NULL, energy_today_kwh REAL, energy_total_kwh REAL,
      frame_id INTEGER NOT NULL REFERENCES growatt_frames(id),
      PRIMARY KEY(serial, measured_ms)
    );
    CREATE INDEX IF NOT EXISTS inverter_received ON inverter_measurements(serial, received_ms);
    CREATE TABLE IF NOT EXISTS meter_measurements (
      device TEXT NOT NULL, measured_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      net_power_w REAL NOT NULL, import_kwh REAL, export_kwh REAL,
      PRIMARY KEY(device, measured_ms)
    );
    CREATE INDEX IF NOT EXISTS meter_received ON meter_measurements(device, received_ms);
  `);
  return db;
}
