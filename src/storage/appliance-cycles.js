const maximumDurationMs = 24 * 3600000, maximumPoints = 20000;

/** Voegt begrensde apparaatcycli en hun vermogensmetingen toe; input: SQLite; output: void. */
export function createApplianceCycleSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS appliance_cycles (
    id INTEGER PRIMARY KEY, appliance_id TEXT NOT NULL, config_key TEXT NOT NULL,
    started_ms INTEGER NOT NULL, ended_ms INTEGER,
    state TEXT NOT NULL CHECK(state IN ('pending','active','completed','interrupted')),
    complete INTEGER NOT NULL CHECK(complete IN (0,1)), gap_ms INTEGER NOT NULL,
    last_ms INTEGER NOT NULL, sample_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(appliance_id,started_ms), CHECK(ended_ms IS NULL OR ended_ms>=started_ms)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS appliance_one_open_cycle ON appliance_cycles(appliance_id) WHERE state IN ('pending','active');
  CREATE TABLE IF NOT EXISTS appliance_cycle_samples (
    cycle_id INTEGER NOT NULL REFERENCES appliance_cycles(id) ON DELETE CASCADE,
    measured_ms INTEGER NOT NULL, power_w REAL NOT NULL CHECK(power_w>=0),
    PRIMARY KEY(cycle_id,measured_ms)
  ) WITHOUT ROWID;`);
}

/** Bewaart alleen herkende cycli met maximaal twee afgesloten voorbeelden per apparaat; input: SQLite; output: intern recordCycle en leesmethode. */
export function createApplianceCycleStore(db) {
  const q = {
    open: db.prepare("SELECT * FROM appliance_cycles WHERE appliance_id=? AND state IN ('pending','active')"),
    same: db.prepare('SELECT * FROM appliance_cycles WHERE appliance_id=? AND started_ms=?'),
    add: db.prepare('INSERT INTO appliance_cycles(appliance_id,config_key,started_ms,state,complete,gap_ms,last_ms) VALUES(?,?,?,?,?,?,?)'),
    remove: db.prepare('DELETE FROM appliance_cycles WHERE id=?'),
    sample: db.prepare('INSERT INTO appliance_cycle_samples VALUES(?,?,?) ON CONFLICT DO NOTHING'),
    advance: db.prepare('UPDATE appliance_cycles SET state=?,complete=?,last_ms=?,sample_count=sample_count+? WHERE id=?'),
    finish: db.prepare('UPDATE appliance_cycles SET state=?,complete=?,ended_ms=?,last_ms=?,sample_count=? WHERE id=?'),
    trim: db.prepare('DELETE FROM appliance_cycle_samples WHERE cycle_id=? AND measured_ms>?'),
    count: db.prepare('SELECT count(*) AS count,max(measured_ms) AS last_ms FROM appliance_cycle_samples WHERE cycle_id=?'),
    prune: db.prepare("DELETE FROM appliance_cycles WHERE appliance_id=? AND state IN ('completed','interrupted') AND id NOT IN (SELECT id FROM appliance_cycles WHERE appliance_id=? AND state IN ('completed','interrupted') ORDER BY started_ms DESC,id DESC LIMIT 2)"),
    runs: db.prepare("SELECT * FROM appliance_cycles WHERE appliance_id=? AND state<>'pending' ORDER BY started_ms DESC,id DESC"),
    samples: db.prepare('SELECT measured_ms,power_w FROM appliance_cycle_samples WHERE cycle_id=? ORDER BY measured_ms')
  };

  /** Sluit een cyclus af en verwijdert de bevestigingswachttijd na het echte einde; input: cyclus, eindtijd en afgerond-vlag; output: void. */
  function finish(run, end, completed) {
    end = Math.max(run.started_ms, end);
    q.trim.run(run.id, end);
    const samples = q.count.get(run.id);
    q.finish.run(completed ? 'completed' : 'interrupted', Number(completed && Boolean(run.complete) && samples.count >= 2 && end > run.started_ms),
      end, samples.last_ms ?? run.started_ms, samples.count, run.id);
  }

  /** Volgt de bevestigde sockettoestand en neemt de startbuffer mee; input: bewaarde socketrij en vorige toestand; output: void, binnen de sockettransactie. */
  function recordCycle(row, previous) {
    const state = row.state, at = state.measured_ms;
    let run = q.open.get(row.appliance_id);
    const prune = () => q.prune.run(row.appliance_id, row.appliance_id);
    if (run && run.config_key !== row.config_key) {
      if (run.state === 'pending') q.remove.run(run.id); else finish(run, run.last_ms, false);
      run = null;
    }
    if (state.error || !Number.isFinite(at) || !Number.isFinite(state.power_w)) {
      if (run?.state === 'pending') q.remove.run(run.id);
      prune(); return;
    }
    const start = state.running ? state.started_ms : state.pending_start_ms;
    const tracking = Number.isFinite(start);
    if (run && (!tracking || run.started_ms !== start)) {
      if (run.state === 'pending') q.remove.run(run.id);
      else {
        const completed = previous?.running && !state.running && Number.isFinite(state.stopped_ms);
        const end = completed ? previous.pending_stop_ms ?? at : run.last_ms;
        if (completed && end === at) q.sample.run(run.id, at, state.power_w);
        finish(run, end, completed);
      }
      run = null;
    }
    if (!tracking) { prune(); return; }
    if (!run) {
      // Een begrensde of onderbroken cyclus mag niet telkens opnieuw worden aangemaakt.
      if (q.same.get(row.appliance_id, start)) { prune(); return; }
      const observedStart = start === at && previous?.running === false && previous.pending_start_ms === null && !previous.error
        && Number.isFinite(previous.measured_ms) && start >= previous.measured_ms && start - previous.measured_ms <= (row.max_gap_ms ?? 120000);
      const id = Number(q.add.run(row.appliance_id, row.config_key, start, state.running ? 'active' : 'pending', Number(observedStart),
        row.max_gap_ms ?? 120000, at).lastInsertRowid);
      run = q.same.get(row.appliance_id, start);
      run.id = id;
    }
    if (at < run.last_ms) { prune(); return; }
    if (at - run.started_ms > maximumDurationMs || run.sample_count >= maximumPoints) {
      finish(run, run.last_ms, false); prune(); return;
    }
    const inserted = q.sample.run(run.id, at, state.power_w).changes;
    const complete = Boolean(run.complete) && at - run.last_ms <= run.gap_ms;
    q.advance.run(state.running ? 'active' : 'pending', Number(complete), at, inserted, run.id);
    prune();
  }

  return {
    recordCycle,
    /** Leest de lopende en maximaal twee afgesloten cycli met hun meetpunten; input: apparaat-id; output: chronologisch dalende cycli. */
    applianceCycles(id) { return q.runs.all(id).map((run) => ({ ...run, complete: Boolean(run.complete), points: q.samples.all(run.id) })); }
  };
}
