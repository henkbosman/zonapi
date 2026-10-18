import { setupDiagnosticControls } from './diagnostic-controls.js';
import { renderGrowattCloud, setupGrowattCloud, showGrowattCloudCall } from './growatt-cloud.js';
import { renderGrowattProduction } from './growatt-production.js';

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

/** Maakt een knop voor één lokaal pakket of webverzoek; input: log-id en optionele cloudvlag; output: button-element. */
function frameButton(id, cloud = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset[cloud ? 'cloudCallId' : 'frameId'] = String(id);
  button.textContent = 'Bekijk';
  return button;
}

/** Toont luisteradres, bronstatus en aantallen; input: Growatt-overzicht; output: void. */
function renderSummary(data) {
  const listener = data.listener;
  const state = listener.listening === true ? 'luistert' : listener.listening === false ? 'luistert niet' : 'status onbekend';
  const error = listener.last_error ? ` · ${listener.last_error.code ?? listener.last_error.message}` : '';
  element('#listener').textContent = `TCP: ${listener.host}:${listener.port} · ${state}${error}`;
  element('#db-path').textContent = `Database: ${data.database_path ?? 'geheugen'}`;
  renderGrowattCloud(data.cloud);
  element('#frame-count').textContent = data.summary.frames_total.toLocaleString('nl-NL');
  element('#discovered').textContent = `${data.announcements.length}/${data.production.expected_inverters}`;
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

/** Toont pakketten en verbindingen in chronologische volgorde; input: gefilterde tijdlijn; output: void. */
function renderTimeline(data) {
  const body = element('#timeline');
  body.replaceChildren();
  if (!data.rows.length) showEmpty(body, 8, 'Geen berichten voor dit filter');
  for (const row of data.rows) {
    const packet = row.source === 'packet';
    const isError = packet ? !['control', 'announcement'].includes(row.status) && !row.status.startsWith('decoded:') : row.source === 'cloud' ? row.status === 'error' : !['connected', 'disconnected', 'idle_disconnect', 'reply_sent', 'time_sync_sent', 'time_sync_response'].includes(row.status);
    const item = addRow(body, [
      time(row.at), row.label, row.record_type?.toUpperCase() ?? '—',
      packet ? row.record_type?.slice(0, 2).toUpperCase() ?? '—' : '—', row.status,
      packet ? row.peer : `${row.peer} · ${row.detail ?? ''}`,
      row.size_bytes ?? '—', packet ? frameButton(row.id) : row.source === 'cloud' ? frameButton(row.id, true) : '—'
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
    const frame = await request(`/intern/api/v1/growatt/frames/${id}`);
    element('#detail-title').textContent = `Pakket #${frame.id}`;
    fillMeta(element('#detail-meta'), [time(frame.received_at), frame.peer, `v${frame.protocol}`, frame.record_type, frame.label, frame.status, `${frame.size_bytes} bytes`]);
    fillMeta(element('#detail-announcement'), frame.announcement ? [`Adres ${frame.announcement.address}`, `Omvormer ${frame.announcement.inverter_serial}`, `Logger ${frame.announcement.datalogger_serial}`] : []);
    const rf = frame.rf_configuration;
    fillMeta(element('#detail-rf-configuration'), rf ? [
      `RF-stick ${rf.rf_serial}`, `Interval ${rf.update_interval_minutes ?? '—'} min`,
      `Firmware ${rf.firmware ?? '—'}`, `Tijdzone ${rf.timezone ?? '—'}`,
      `Apparaatklok ${rf.device_time ?? '—'}`,
      ...Object.entries(rf.registers).map(([register, value]) => `Register ${register}: ${value}`)
    ] : []);
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
  const cloud = event.target.closest?.('button[data-cloud-call-id]');
  if (cloud) void showGrowattCloudCall(cloud.dataset.cloudCallId);
}

/** Werkt de Growatt-diagnosepanelen bij; input: Growatt-overzicht; output: void. */
function renderOverview(data) {
  renderLogging(data.logging);
  renderSummary(data);
  renderAnnouncements(data);
}

/** Leest en tekent één zelfstandig paginadeel; input: endpoint, tekenfunctie en vernieuwnummer; output: Promise met antwoord of fout. */
async function refreshSection(path, render, current) {
  const data = await request(path);
  if (current === refreshNumber) render(data);
  return data;
}

/** Vernieuwt metingen, bronstatus en tijdlijn onafhankelijk; input: geen; output: Promise<void>, fouten blijven per onderdeel zichtbaar. */
async function refresh() {
  const current = ++refreshNumber;
  const query = new URLSearchParams({ limit: String(pageSize), offset: String(offset), view: element('#view-filter').value });
  if (element('#type-filter').value) query.set('type', element('#type-filter').value);
  if (element('#address-filter').value) query.set('address', element('#address-filter').value);
  const results = await Promise.allSettled([
    refreshSection('/intern/api/v1/production/current', renderGrowattProduction, current),
    refreshSection('/intern/api/v1/growatt?limit=1', renderOverview, current),
    refreshSection(`/intern/api/v1/growatt/timeline?${query}`, renderTimeline, current)
  ]);
  if (current !== refreshNumber) return;
  const labels = ['Metingen', 'Bronstatus', 'Berichten'];
  const errors = results.flatMap((result, index) => result.status === 'rejected' ? [`${labels[index]}: ${result.reason.message}`] : []);
  const serverTime = results[1].status === 'fulfilled' ? results[1].value.server_time : new Date().toISOString();
  element('#connection').textContent = errors.length ? errors.join(' · ') : `Bijgewerkt ${time(serverTime)}`;
}

/** Wijzigt de tijdlijnfilters en start op de nieuwste pagina; input: geen (leest selectievelden); output: void. */
function changeFilter() {
  if (['events', 'cloud'].includes(element('#view-filter').value)) {
    element('#type-filter').value = '';
    element('#address-filter').value = '';
  }
  element('#type-filter').disabled = ['events', 'cloud'].includes(element('#view-filter').value);
  element('#address-filter').disabled = ['events', 'cloud'].includes(element('#view-filter').value);
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
const renderLogging = setupDiagnosticControls('growatt', refresh, () => {
  refreshNumber++;
  offset = 0;
  element('#frame-detail').hidden = true;
});
element('#newer').addEventListener('click', () => changePage(-1));
element('#older').addEventListener('click', () => changePage(1));
setupGrowattCloud(refresh);
void refresh();
setInterval(() => { void refresh(); }, 15000);
