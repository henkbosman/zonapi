/** Bewaart HomeWizard-pogingen en de laatste apparaatstatus; input: SQLite en diagnoseopslag; output: opslagmethoden. */
export function createHomeWizardCallStore(db, diagnostics) {
  return {
    /** Bewaart een geslaagde of mislukte lokale poll; input: poging met tijd, apparaat, URL, duur, detail en meting; output: void. */
    saveHomeWizardCall(row) {
      diagnostics.saveDiagnosticState('homewizard', row.device, row);
      if (!diagnostics.loggingStatus('homewizard').enabled) return;
      db.prepare('INSERT INTO homewizard_calls(attempted_ms,device,status,request_url,duration_ms,detail,measurement) VALUES(?,?,?,?,?,?,?)')
        .run(row.attempted_ms, row.device, row.status, row.request_url, row.duration_ms, row.detail ?? null, row.measurement ? JSON.stringify(row.measurement) : null);
      diagnostics.trimDiagnostics('homewizard');
    },
    /** Leest een gefilterde pagina lokale pollresultaten; input: status, apparaat, limiet en offset; output: rijen en has_more. */
    recentHomeWizardCalls({ status, device, limit, offset }) {
      const clauses = [], values = [];
      if (status !== 'all') { clauses.push('status=?'); values.push(status); }
      if (device !== 'all') { clauses.push('device=?'); values.push(device); }
      const rows = db.prepare(`SELECT * FROM homewizard_calls ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...values, limit + 1, offset);
      return { rows: rows.slice(0, limit).map((row) => ({ ...row, measurement: row.measurement ? JSON.parse(row.measurement) : null })), has_more: rows.length > limit };
    },
    /** Verwijdert lokale poll-logs met behoud van metingen; input: geen; output: verwijderd aantal. */
    clearHomeWizardDiagnostics() { return { calls_deleted: db.prepare('DELETE FROM homewizard_calls').run().changes }; }
  };
}
