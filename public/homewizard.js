import { setupDiagnosticControls } from './diagnostic-controls.js';

const timeFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const deviceNames = { p1: 'P1', kwh: 'kWh-meter' };
const activityNames = { running: 'Aan', starting: 'Start wordt herkend', idle: 'Uit', waiting: 'Wacht op meting', unavailable: 'Niet beschikbaar' };
let offset = 0;
let refreshId = 0;
let current = null;

/** Kiest één paginaveld; input: CSS-selector; output: Element of null. */
function element(selector) { return document.querySelector(selector); }

/** Formatteert een tijdstip; input: ISO-tijd of epoch-ms; output: datum/tijd of streepje. */
function time(value) { return value === null || value === undefined ? '—' : timeFormat.format(new Date(value)); }

/** Formatteert een optioneel getal met eenheid; input: getal, eenheid en decimalen; output: tekst. */
function number(value, unit, decimals = 0) { return Number.isFinite(value) ? `${value.toLocaleString('nl-NL', { maximumFractionDigits: decimals })} ${unit}` : '—'; }

/** Vraagt lokale JSON-gegevens op; input: pad en optionele fetch-opties; output: Promise met JSON of fout. */
async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/** Plaatst tekstcellen in één tabelrij; input: tabelbody en waarden; output: HTMLTableRowElement. */
function addRow(body, values) {
  const row = document.createElement('tr');
  for (const value of values) { const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell); }
  body.append(row); return row;
}

/** Toont meetwaarden, lokale instellingen en actuele fouten; input: HomeWizard-overzicht; output: void. */
function renderStatus(data) {
  renderLogging(data.logging);
  element('#poll-interval').textContent = `Interval: ${data.poll_seconds} s`;
  element('#meter-priority').textContent = `Actieve netmeter: ${deviceNames[data.selected_device] ?? '—'}`;
  element('#net-power').textContent = number(data.net_power_w, 'W');
  element('#net-direction').textContent = data.net_power_w === null ? '—' : data.net_power_w < 0 ? 'Teruglevering' : data.net_power_w > 0 ? 'Afname' : 'In balans';
  const body = element('#devices'); body.replaceChildren();
  for (const device of data.devices) {
    const meter = device.measurement;
    const state = !device.configured ? 'Niet ingesteld' : device.error ? 'Fout' : device.activity ? activityNames[device.activity.state] : meter?.fresh ? 'Actief' : 'Geen recente meting';
    deviceNames[device.device] = device.name ?? deviceNames[device.device] ?? device.device;
    if (device.kind !== 'socket') {
      element(`#${device.device}-state`).textContent = state;
      element(`#${device.device}-time`).textContent = time(meter?.measured_at);
    }
    const row = addRow(body, [deviceNames[device.device], device.host ?? '—', device.api, state, number(meter?.net_power_w, 'W'),
      number(meter?.import_kwh, 'kWh', 3), number(meter?.export_kwh, 'kWh', 3), time(meter?.measured_at),
      number(device.latest_call?.duration_ms, 'ms'), device.configured ? device.error ?? '—' : '—']);
    if (device.error && device.configured) row.classList.add('timeline-error');
  }
  const filter = element('#device-filter'), selected = filter.value;
  filter.replaceChildren();
  for (const device of [{ device: 'all', name: 'Alles' }, ...data.devices]) {
    const option = document.createElement('option'); option.value = device.device; option.textContent = device.name ?? deviceNames[device.device]; filter.append(option);
  }
  if (selected !== 'all' && !data.devices.some((device) => device.device === selected)) {
    const option = document.createElement('option'); option.value = selected; option.textContent = deviceNames[selected] ?? selected; filter.append(option);
  }
  filter.value = selected;
}

/** Toont de gefilterde polltijdlijn; input: HomeWizard-overzicht; output: void. */
function renderCalls(data) {
  const body = element('#meter-calls'); body.replaceChildren();
  for (const call of data.calls.rows) {
    const row = addRow(body, [time(call.attempted_ms), deviceNames[call.device] ?? call.device, call.status, number(call.duration_ms, 'ms'), number(call.measurement?.net_power_w, 'W'), call.detail ?? '—']);
    if (call.status === 'error') row.classList.add('timeline-error');
    const cell = document.createElement('td'), button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Bekijk'; button.dataset.callId = String(call.id);
    cell.append(button); row.append(cell);
  }
  if (!data.calls.rows.length) {
    const row = document.createElement('tr'), cell = document.createElement('td');
    cell.colSpan = 7; cell.className = 'empty-row'; cell.textContent = 'Geen verzoeken voor dit filter'; row.append(cell); body.append(row);
  }
  element('#newer').disabled = data.calls.offset === 0;
  element('#older').disabled = !data.calls.has_more;
  element('#page-info').textContent = data.calls.rows.length ? `${data.calls.offset + 1}–${data.calls.offset + data.calls.rows.length}` : 'Geen resultaten';
}

/** Vernieuwt lokale meterstatus en logboek; input: geen; output: Promise<void>. */
async function refresh() {
  const id = ++refreshId;
  const query = new URLSearchParams({ limit: '50', offset: String(offset), status: element('#status-filter').value, device: element('#device-filter').value });
  try {
    const data = await request(`/intern/api/v1/homewizard?${query}`);
    if (id !== refreshId) return;
    current = data; renderStatus(data); renderCalls(data);
    element('#connection').textContent = `Bijgewerkt ${time(data.server_time)}`;
  } catch (error) { if (id === refreshId) element('#connection').textContent = `Fout: ${error.message}`; }
}

/** Leest op verzoek de ingestelde lokale meters; input: geen; output: Promise<void>. */
async function pollNow() {
  const button = element('#poll-now'); button.disabled = true;
  try { await request('/intern/api/v1/homewizard/poll', { method: 'POST' }); await refresh(); }
  catch (error) { element('#connection').textContent = `Fout: ${error.message}`; }
  finally { button.disabled = false; }
}

const renderLogging = setupDiagnosticControls('homewizard', refresh, () => {
  refreshId++; offset = 0; current = null; element('#call-detail').hidden = true;
});
element('#refresh-now').addEventListener('click', () => { void refresh(); });
element('#poll-now').addEventListener('click', () => { void pollNow(); });
for (const id of ['#status-filter', '#device-filter']) element(id).addEventListener('change', () => { offset = 0; void refresh(); });
element('#newer').addEventListener('click', () => { offset = Math.max(0, offset - 50); void refresh(); });
element('#older').addEventListener('click', () => { offset += 50; void refresh(); });
element('#meter-calls').addEventListener('click', (event) => {
  const id = event.target.closest?.('button[data-call-id]')?.dataset.callId;
  const call = current?.calls.rows.find((row) => row.id === Number(id));
  if (!call) return;
  element('#call-url').textContent = call.request_url;
  element('#call-result').textContent = call.detail ?? call.status;
  element('#call-measurement').textContent = call.measurement ? JSON.stringify(call.measurement, null, 2) : '—';
  element('#call-detail').hidden = false;
  element('#call-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
void refresh();
setInterval(() => { void refresh(); }, 15000);
