const dateTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const pageSize = 100;
let offset = 0;
let refreshNumber = 0;

/** Vindt één element op de Growatt-pagina; input: CSS-selector; output: Element of null. */
function element(selector) { return document.querySelector(selector); }

/** Leest één API-endpoint; input: pad; output: Promise met JSON of fout. */
async function request(path) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
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
  element('#discovered').textContent = `${data.announcements.length}/${data.production.expected_inverters}`;
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

/** Toont aanmeldingen met hun omvormeradres en serienummers; input: Growatt-overzicht; output: void. */
function renderAnnouncements(data) {
  const body = element('#announcements');
  body.replaceChildren();
  if (!data.announcements.length) return showEmpty(body, 5, 'Geen aanmeldingen');
  for (const announcement of data.announcements) addRow(body, [
    announcement.address, announcement.inverter_serial, announcement.datalogger_serial,
    time(announcement.last_seen_at), announcement.record_type
  ]);
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

/** Toont pakketten en verbindingen in chronologische volgorde; input: gefilterde tijdlijn; output: void. */
function renderTimeline(data) {
  const body = element('#timeline');
  body.replaceChildren();
  if (!data.rows.length) showEmpty(body, 8, 'Geen berichten voor dit filter');
  for (const row of data.rows) {
    const packet = row.source === 'packet';
    const isError = packet ? !['control', 'announcement'].includes(row.status) && !row.status.startsWith('decoded:') : !['connected', 'disconnected', 'idle_disconnect', 'reply_sent', 'time_sync_sent'].includes(row.status);
    const item = addRow(body, [
      time(row.at), row.label, row.record_type?.toUpperCase() ?? '—',
      packet ? row.record_type?.slice(0, 2).toUpperCase() ?? '—' : '—', row.status,
      packet ? row.peer : `${row.peer} · ${row.detail ?? ''}`,
      row.size_bytes ?? '—', packet ? frameButton(row.id) : '—'
    ]);
    if (isError) item.classList.add('timeline-error');
    else if (!packet) item.classList.add('timeline-event');
  }
  element('#newer').disabled = data.offset === 0;
  element('#older').disabled = !data.has_more;
  element('#page-info').textContent = data.rows.length ? `${data.offset + 1}–${data.offset + data.rows.length}` : 'Geen resultaten';
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
    fillMeta(element('#detail-meta'), [time(frame.received_at), frame.peer, `v${frame.protocol}`, frame.record_type, frame.label, frame.status, `${frame.size_bytes} bytes`]);
    fillMeta(element('#detail-announcement'), frame.announcement ? [`Adres ${frame.announcement.address}`, `Omvormer ${frame.announcement.inverter_serial}`, `Logger ${frame.announcement.datalogger_serial}`] : []);
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

/** Vernieuwt de Growatt-metingen en de gefilterde tijdlijn; input: geen; output: Promise<void>. */
async function refresh() {
  const current = ++refreshNumber;
  const query = new URLSearchParams({ limit: String(pageSize), offset: String(offset), view: element('#view-filter').value });
  if (element('#type-filter').value) query.set('type', element('#type-filter').value);
  if (element('#address-filter').value) query.set('address', element('#address-filter').value);
  try {
    const [data, timeline] = await Promise.all([request('/api/v1/growatt?limit=1'), request(`/api/v1/growatt/timeline?${query}`)]);
    if (current !== refreshNumber) return;
    renderSummary(data);
    renderAnnouncements(data);
    renderInverters(data);
    renderTimeline(timeline);
    element('#connection').textContent = `Bijgewerkt ${time(data.server_time)}`;
  } catch (error) {
    if (current === refreshNumber) element('#connection').textContent = `Fout: ${error.message}`;
  }
}

/** Wist de ruwe pakketten en verbindingslogs na bevestiging; input: geen; output: Promise<void>. */
async function clearLogs() {
  if (!window.confirm('Alle Growatt-berichten en logs verwijderen?')) return;
  const button = element('#clear-logs');
  button.disabled = true;
  refreshNumber++;
  try {
    const response = await fetch('/api/v1/growatt/diagnostics', { method: 'DELETE', cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    offset = 0;
    element('#frame-detail').hidden = true;
    await refresh();
  } catch (error) {
    element('#connection').textContent = `Fout: ${error.message}`;
  } finally { button.disabled = false; }
}

/** Wijzigt de tijdlijnfilters en start op de nieuwste pagina; input: geen (leest selectievelden); output: void. */
function changeFilter() {
  if (element('#view-filter').value === 'events') {
    element('#type-filter').value = '';
    element('#address-filter').value = '';
  }
  element('#type-filter').disabled = element('#view-filter').value === 'events';
  element('#address-filter').disabled = element('#view-filter').value === 'events';
  offset = 0;
  element('#frame-detail').hidden = true;
  void refresh();
}

/** Bladert door de gefilterde tijdlijn; input: richting -1 of 1; output: void. */
function changePage(direction) {
  offset = Math.max(0, offset + pageSize * direction);
  element('#frame-detail').hidden = true;
  void refresh();
}

document.addEventListener('click', handleFrameClick);
for (const id of ['#view-filter', '#type-filter', '#address-filter']) element(id).addEventListener('change', changeFilter);
element('#refresh-now').addEventListener('click', () => { void refresh(); });
element('#clear-logs').addEventListener('click', () => { void clearLogs(); });
element('#newer').addEventListener('click', () => changePage(-1));
element('#older').addEventListener('click', () => changePage(1));
void refresh();
setInterval(() => { void refresh(); }, 15000);
