const dateTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Vindt één element op de Growatt-pagina; input: CSS-selector; output: Element of null. */
function element(selector) { return document.querySelector(selector); }

/** Leest één API-endpoint; input: pad; output: Promise met JSON of fout. */
async function request(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Formatteert een UTC-tijd voor het dashboard; input: ISO-tijd of null; output: lokale tijd of streepje. */
function time(value) { return value ? dateTime.format(new Date(value)) : '—'; }

/** Formatteert een optioneel vermogen; input: watt of null; output: tekst met eenheid. */
function watts(value) { return value === null || value === undefined ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} kW` : `${Math.round(value)} W`; }

/** Plaatst een rij met tekst of knoppen; input: tabelgedeelte en celwaarden; output: tabelrij. */
function addRow(body, values) {
  const row = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement('td');
    if (value instanceof Node) cell.append(value);
    else cell.textContent = String(value);
    row.append(cell);
  }
  body.append(row);
  return row;
}

/** Toont een lege tabelstatus; input: tabelgedeelte, aantal kolommen en tekst; output: void. */
function showEmpty(body, columns, label) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = columns;
  cell.className = 'empty-row';
  cell.textContent = label;
  row.append(cell);
  body.append(row);
}

/** Maakt een knop voor de volledige pakketinhoud; input: pakket-id; output: button-element. */
function frameButton(id) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.frameId = String(id);
  button.textContent = 'Bekijk';
  return button;
}

/** Toont luisteradres, metingen en aantallen; input: Growatt-overzicht; output: void. */
function renderSummary(data) {
  element('#listener').textContent = `TCP: ${data.listener.host}:${data.listener.port}`;
  element('#updated').textContent = `Meetstatus: ${data.production.status}`;
  element('#frame-count').textContent = data.summary.frames_total.toLocaleString('nl-NL');
  element('#power').textContent = watts(data.production.power_w);
  element('#active').textContent = `${data.production.active_inverters}/${data.production.expected_inverters}`;
  element('#last-frame').textContent = time(data.summary.last_received_at);
  const list = element('#frame-statuses');
  list.replaceChildren();
  if (!data.statuses.length) { list.textContent = 'Geen pakketten'; return; }
  for (const status of data.statuses) {
    const item = document.createElement('span');
    item.className = 'status-pill';
    item.append(document.createTextNode(status.status));
    const count = document.createElement('strong');
    count.textContent = status.count.toLocaleString('nl-NL');
    item.append(count);
    list.append(item);
  }
}

/** Toont de laatste meting per omvormer; input: Growatt-overzicht; output: void. */
function renderInverters(data) {
  const body = element('#inverters');
  body.replaceChildren();
  if (!data.production.inverters.length) return showEmpty(body, 6, 'Geen metingen');
  for (const inverter of data.production.inverters) addRow(body, [
    inverter.serial, watts(inverter.power_w),
    inverter.energy_today_kwh === null ? '—' : `${inverter.energy_today_kwh} kWh`,
    inverter.energy_total_kwh === null ? '—' : `${inverter.energy_total_kwh} kWh`,
    time(inverter.measured_at), inverter.fresh ? 'Actueel' : 'Oud'
  ]);
}

/** Toont de laatste ontvangen pakketheaders; input: Growatt-overzicht; output: void. */
function renderFrames(data) {
  const body = element('#frames');
  body.replaceChildren();
  if (!data.frames.length) return showEmpty(body, 8, 'Geen pakketten');
  for (const frame of data.frames) addRow(body, [
    time(frame.received_at), frame.id, frame.peer, `v${frame.protocol}`,
    frame.record_type, frame.status, frame.size_bytes, frameButton(frame.id)
  ]);
}

/** Toont pakket- en ontvangerfouten; input: Growatt-overzicht; output: void. */
function renderProblems(data) {
  const body = element('#problems');
  body.replaceChildren();
  if (!data.problems.length) return showEmpty(body, 5, 'Geen fouten');
  for (const problem of data.problems) addRow(body, [
    time(problem.at), problem.peer, problem.status, problem.detail ?? '—',
    problem.frame_id === null ? '' : frameButton(problem.frame_id)
  ]);
}

/** Maakt compacte metadata voor één pakket; input: container en waarden; output: void. */
function fillMeta(container, values) {
  container.replaceChildren();
  for (const value of values) {
    const item = document.createElement('span');
    item.textContent = value;
    container.append(item);
  }
}

/** Leest en toont een geselecteerd pakket inclusief ruwe bytes; input: pakket-id; output: Promise<void>. */
async function showFrame(id) {
  try {
    const frame = await request(`/api/v1/growatt/frames/${id}`);
    element('#detail-title').textContent = `Pakket #${frame.id}`;
    fillMeta(element('#detail-meta'), [time(frame.received_at), frame.peer, `v${frame.protocol}`, frame.record_type, frame.status, `${frame.size_bytes} bytes`]);
    fillMeta(element('#detail-measurement'), frame.measurement ? [frame.measurement.serial, watts(frame.measurement.power_w), `${frame.measurement.energy_today_kwh} kWh vandaag`, `${frame.measurement.energy_total_kwh} kWh totaal`, time(frame.measurement.measured_at)] : []);
    element('#detail-hex').textContent = (frame.raw_hex.match(/.{1,32}/g) ?? []).map((line) => (line.match(/../g) ?? []).join(' ')).join('\n');
    element('#frame-detail').hidden = false;
    element('#frame-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    element('#connection').textContent = `Fout: ${error.message}`;
  }
}

/** Opent de pakketinhoud bij een klik in een tabel; input: muisklik; output: void. */
function handleFrameClick(event) {
  const button = event.target.closest?.('button[data-frame-id]');
  if (button) void showFrame(button.dataset.frameId);
}

/** Vernieuwt de Growatt-metingen en diagnostiek; input: geen; output: Promise<void>. */
async function refresh() {
  try {
    const data = await request('/api/v1/growatt?limit=50');
    renderSummary(data);
    renderInverters(data);
    renderFrames(data);
    renderProblems(data);
    element('#connection').textContent = 'Online';
  } catch (error) {
    element('#connection').textContent = `Fout: ${error.message}`;
  }
}

document.addEventListener('click', handleFrameClick);
void refresh();
setInterval(refresh, 15000);
