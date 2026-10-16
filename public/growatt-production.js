const dateTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Formatteert de meet- of ontvangsttijd; input: ISO-tijd of null; output: lokale datum/tijd of streepje. */
function time(value) {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? dateTime.format(new Date(at)) : '—';
}

/** Formatteert een omvormervermogen; input: watt of null; output: watt, kilowatt of streepje. */
function watts(value) {
  return !Number.isFinite(value) ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} kW` : `${Math.round(value)} W`;
}

/** Formatteert een energieteller; input: kWh of null; output: teller met eenheid of streepje. */
function energy(value) { return Number.isFinite(value) ? `${value} kWh` : '—'; }

/** Werkt de actuele opbrengst en omvormertabel bij; input: antwoord van /api/v1/production/current; output: void. */
export function renderGrowattProduction(production) {
  document.getElementById('power').textContent = watts(production.power_w);
  document.getElementById('active').textContent = `${production.active_inverters}/${production.expected_inverters}`;
  document.getElementById('updated').textContent = `Meetstatus: ${production.status}`;
  const sources = { shinelink: 'ShineLink', cloud: 'Growatt-web-API', auto: 'Automatisch' };
  document.getElementById('production-source').textContent = `Opbrengstbron: ${sources[production.production_source] ?? '—'}`;
  const body = document.getElementById('inverters');
  body.replaceChildren();
  if (!production.inverters.length) {
    const row = document.createElement('tr'), cell = document.createElement('td');
    cell.colSpan = 8;
    cell.className = 'empty-row';
    cell.textContent = 'Geen metingen';
    row.append(cell);
    body.append(row);
    return;
  }
  for (const inverter of production.inverters) {
    const row = document.createElement('tr');
    const source = inverter.source === 'cloud' ? 'Web-API' : inverter.source === 'shinelink' ? 'ShineLink' : '—';
    for (const value of [inverter.serial, source, watts(inverter.power_w), energy(inverter.energy_today_kwh),
      energy(inverter.energy_total_kwh), time(inverter.measured_at), time(inverter.received_at), inverter.fresh ? 'Actueel' : 'Oud']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
}
