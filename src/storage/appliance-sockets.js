import { createApplianceCycleStore } from './appliance-cycles.js';

/** Bewaart socketstatus en begrensde cyclusmetingen atomair; input: SQLite; output: lees-/schrijfmethoden. */
export function createApplianceSocketStore(db) {
  const { recordCycle, ...cycles } = createApplianceCycleStore(db);
  const save = db.prepare(`INSERT INTO appliance_socket_state(appliance_id,config_key,updated_ms,state_json) VALUES(?,?,?,?)
    ON CONFLICT(appliance_id) DO UPDATE SET config_key=excluded.config_key,updated_ms=excluded.updated_ms,state_json=excluded.state_json
    WHERE excluded.updated_ms>=appliance_socket_state.updated_ms`);
  const read = db.prepare('SELECT * FROM appliance_socket_state WHERE appliance_id=?');
  return {
    ...cycles,
    /** Overschrijft de laatste toestand en bewaart uitsluitend de herkende cyclus; input: apparaat-id, sleutel, tijd en status; output: SQLite-resultaat. */
    saveApplianceSocketState(row) {
      db.exec('SAVEPOINT socket_measurement');
      try {
        const old = read.get(row.appliance_id);
        const result = save.run(row.appliance_id, row.config_key, row.updated_ms, JSON.stringify(row.state));
        if (result.changes) recordCycle(row, old?.config_key === row.config_key ? JSON.parse(old.state_json) : null);
        db.exec('RELEASE socket_measurement');
        return result;
      } catch (error) { db.exec('ROLLBACK TO socket_measurement; RELEASE socket_measurement'); throw error; }
    },
    /** Leest een bewaarde herkenning, ook na herstart; input: apparaat-id; output: statusrij of null. */
    applianceSocketState(id) { const row = read.get(id); return row ? { appliance_id: row.appliance_id, config_key: row.config_key, updated_ms: row.updated_ms, state: JSON.parse(row.state_json) } : null; }
  };
}
