import { drawRadiationChart } from './weather-chart.js';
import { setupDiagnosticControls } from './diagnostic-controls.js';

const fullTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'long' });
const shortTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
let offset = 0;
let refreshId = 0;
let current = null;

/** Kiest één paginaveld; input: CSS-selector; output: Element of null. */
function element(selector) { return document.querySelector(selector); }

/** Formatteert een optioneel tijdstip; input: ISO-tijdstip of null; output: Nederlandse datum/tijd of streepje. */
function time(value) { return value ? fullTime.format(new Date(value)) : '—'; }

/** Haalt JSON zonder cache op; input: URL en optionele fetch-opties; output: Promise met data of fout. */
async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(20000), ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/** Plaatst de weerstatus, vorige verzoeken en geplande poging; input: weerdiagnostiek; output: void. */
function renderStatus(data) {
  const state = data.status;
  element('#weather-source').textContent = `Bron: ${state.source}`;
  element('#weather-location').textContent = data.location.latitude === null ? 'Locatie: —' : `Locatie: ${data.location.latitude}, ${data.location.longitude}`;
  element('#weather-state').textContent = `Status: ${state.fetching ? 'Bezig' : state.last_error ? 'Fout' : !state.location_configured ? 'Geen locatie' : !state.max_requests ? 'Gepauzeerd' : 'Actief'}`;
  element('#requests-today').textContent = `${state.used_requests}/${state.max_requests}`;
  element('#last-attempt').textContent = time(state.last_call?.attempted_ms);
  element('#last-success').textContent = time(data.last_success?.attempted_ms);
  element('#next-fetch').textContent = time(state.next_fetch);
  element('#forecast-count').textContent = String(data.forecast.rows.length);
  element('#forecast-resolution').textContent = data.forecast.resolutions_minutes?.length ? `${data.forecast.resolutions_minutes.join(' / ')} min` : '—';
  element('#request-url').textContent = data.request_url ?? '—';
  element('#last-error').textContent = state.last_error ?? '—';
  element('#sun-times').textContent = state.sunrise && state.sunset ? `${shortTime.format(new Date(state.sunrise))} / ${shortTime.format(new Date(state.sunset))}` : '—';
  element('#chart-date').textContent = dayTime.format(new Date(`${data.forecast.day}T12:00:00Z`));
}

/** Vult één regel van de verzoekentabel; input: HTML-tbody en verzoekrecord; output: void. */
function renderCall(body, row) {
  const tr = document.createElement('tr');
  if (row.status === 'error') tr.classList.add('timeline-error');
  for (const value of [time(row.attempted_at), row.source ?? '—', row.status, row.http_status ?? '—', row.duration_ms === null ? '—' : `${row.duration_ms} ms`, row.forecast_rows ?? '—', row.detail ?? '—']) {
    const cell = document.createElement('td');
    cell.textContent = String(value);
    tr.append(cell);
  }
  const action = document.createElement('td');
  const button = document.createElement('button');
  button.type = 'button'; button.dataset.callId = String(row.id); button.textContent = 'Bekijk';
  action.append(button); tr.append(action); body.append(tr);
}

/** Tekent de verzoekentijdlijn met paginering; input: weeroverzicht; output: void. */
function renderCalls(data) {
  const body = element('#weather-calls');
  body.replaceChildren();
  for (const row of data.calls.rows) renderCall(body, row);
  if (!data.calls.rows.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 8; td.className = 'empty-row'; td.textContent = 'Geen verzoeken voor dit filter'; tr.append(td); body.append(tr);
  }
  element('#newer').disabled = data.calls.offset === 0;
  element('#older').disabled = !data.calls.has_more;
  element('#page-info').textContent = data.calls.rows.length ? `${data.calls.offset + 1}–${data.calls.offset + data.calls.rows.length}` : 'Geen resultaten';
}

/** Toont oorspronkelijke bewolkingsuurpunten, zonder ze naar instralingskwartieren te verschuiven; input: weeroverzicht; output: void. */
function renderConditions(data) {
  const body = element('#weather-conditions');
  body.replaceChildren();
  for (const row of data.conditions?.rows ?? []) {
    const tr = document.createElement('tr');
    const labels = { clear: 'Helder', partly_cloudy: 'Deels bewolkt', cloudy: 'Bewolkt', unknown: 'Onbekend' };
    const models = { icon_d2: 'ICON-D2', best_match: 'Best Match' };
    const strict = { clear: 'Ja', cloudy: 'Nee', unknown: 'Onbekend' };
    for (const value of [time(row.time), row.cloud_cover_percent === null ? '—' : `${row.cloud_cover_percent}%`,
      labels[row.condition] ?? 'Onbekend', row.weather_code ?? '—', models[row.weather_model] ?? row.weather_model ?? '—',
      strict[row.correction_condition] ?? 'Onbekend', `${time(row.fetched_at)}${row.stale ? ' · Verouderd' : ''}`]) {
      const td = document.createElement('td'); td.textContent = String(value); tr.append(td);
    }
    body.append(tr);
  }
  if (!body.children.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 7; td.textContent = 'Nog geen bewolkingsgegevens opgehaald'; tr.append(td); body.append(tr);
  }
}

/** Laat de URL en het resultaat van een geselecteerd verzoek zien; input: verzoekrecord; output: void. */
function showCall(row) {
  const metadata = element('#call-meta'); metadata.replaceChildren();
  for (const value of [time(row.attempted_at), row.source ?? '—', row.status, row.http_status === null ? 'HTTP —' : `HTTP ${row.http_status}`, row.duration_ms === null ? '—' : `${row.duration_ms} ms`]) {
    const pill = document.createElement('span'); pill.textContent = value; metadata.append(pill);
  }
  element('#call-url').textContent = row.request_url ?? '—';
  element('#call-result').textContent = row.detail ?? '—';
  element('#call-detail').hidden = false;
  element('#call-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Laadt weerstatus en tijdlijn en toont de instraling; input: geen; output: Promise<void>. */
async function refresh() {
  const id = ++refreshId;
  try {
    const query = new URLSearchParams({ limit: '50', offset: String(offset), status: element('#status-filter').value });
    const data = await request(`/intern/api/v1/weather?${query}`);
    if (id !== refreshId) return;
    current = data;
    renderLogging(data.logging);
    renderStatus(data);
    renderCalls(data);
    renderConditions(data);
    drawRadiationChart(data.forecast, Date.parse(data.server_time), element('#radiation-chart'));
    element('#connection').textContent = `Bijgewerkt ${time(data.server_time)}`;
  } catch (error) { if (id === refreshId) element('#connection').textContent = `Fout: ${error.message}`; }
}

/** Vraagt één weerupdate binnen daglicht en dagquotum aan; input: geen; output: Promise<void>. */
async function fetchNow() {
  const button = element('#fetch-now'); button.disabled = true;
  try {
    const result = await request('/intern/api/v1/weather/refresh', { method: 'POST' });
    await refresh();
    if (!result.attempted) {
      const reasons = { quota: 'Daglimiet bereikt', paused: 'Weerbron gepauzeerd', busy: 'Verzoek loopt al', interval: 'Nog niet gepland', location: 'Locatie ontbreekt' };
      element('#connection').textContent = reasons[result.reason] ?? result.reason;
    }
  } catch (error) { element('#connection').textContent = `Fout: ${error.message}`; }
  finally { button.disabled = false; }
}

element('#refresh-now').addEventListener('click', () => { void refresh(); });
const renderLogging = setupDiagnosticControls('weather', refresh, () => {
  refreshId++;
  offset = 0;
  current = null;
  element('#call-detail').hidden = true;
});
element('#fetch-now').addEventListener('click', () => { void fetchNow(); });
element('#status-filter').addEventListener('change', () => { offset = 0; void refresh(); });
element('#newer').addEventListener('click', () => { offset = Math.max(0, offset - 50); void refresh(); });
element('#older').addEventListener('click', () => { offset += 50; void refresh(); });
element('#weather-calls').addEventListener('click', (event) => {
  const id = event.target.closest?.('button[data-call-id]')?.dataset.callId;
  const call = current?.calls.rows.find((row) => row.id === Number(id));
  if (call) showCall(call);
});
void refresh();
setInterval(() => { void refresh(); }, 15000);
