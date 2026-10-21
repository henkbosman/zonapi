import { setupProductionDayCharts } from './dashboard-production-days.js';
import { renderPvCorrection } from './pv-correction-status.js';
import { renderDailyAdvice } from './dashboard-daily-advice.js';
import { setupApplianceCharts } from './dashboard-appliance-charts.js';

/** Zoekt één dashboardelement; input: CSS-selector; output: Element of null. */
const $ = (selector) => document.querySelector(selector);
const dutchTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
const dutchDay = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const renderProductionDays = setupProductionDayCharts();
const renderApplianceCharts = setupApplianceCharts($('#appliance-cycle-charts'));

/** Leest één endpoint met expliciete foutstatus; input: pad; output: Promise<JSON> of fout. */
async function json(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

/** Formatteert watt naar een kort getal; input: watt of null; output: leesbare tekst. */
function watts(value) { return value === null || value === undefined ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} kW` : `${Math.round(value)} W`; }

/** Maakt een SVG-element zonder HTML-injectie; input: tag en attributen; output: SVG-element. */
function svg(tag, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/** Tekent een waardegrafiek op gelijke tijdstappen; input: container, {time,value}[], kleur; output: void. */
function drawChart(container, points, color) {
  container.replaceChildren();
  const valid = points.filter((point) => Number.isFinite(point.value));
  if (!valid.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Geen meetpunten';
    container.append(empty);
    return;
  }
  const view = svg('svg', { viewBox: '0 0 600 208', preserveAspectRatio: 'none', role: 'img', 'aria-label': container.getAttribute('aria-label') ?? 'Grafiek' });
  const left = 40, right = 587, top = 12, bottom = 172;
  const maxValue = Math.max(100, Math.ceil(Math.max(...valid.map((point) => point.value)) / 100) * 100);
  const first = Date.parse(valid[0].time), last = Date.parse(valid.at(-1).time);
  for (let i = 0; i <= 3; i++) {
    const y = bottom - (bottom - top) * i / 3;
    view.append(svg('line', { x1:left, y1:y, x2:right, y2:y, stroke:'#e4ece8', 'stroke-width':1 }));
    const label = svg('text', { x:0, y:y + 4, fill:'#607477', 'font-size':11 });
    label.textContent = Math.round(maxValue * i / 3);
    view.append(label);
  }
  const coordinates = valid.map((point) => ({ x:left + (right - left) * (last === first ? 0.5 : (Date.parse(point.time) - first) / (last - first)), y:bottom - (bottom - top) * point.value / maxValue }));
  const path = coordinates.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  if (coordinates.length > 1) view.append(svg('path', { d:`${path} L${coordinates.at(-1).x.toFixed(1)},${bottom} L${coordinates[0].x.toFixed(1)},${bottom} Z`, fill:color, opacity:.12 }));
  view.append(svg('path', { d:path, fill:'none', stroke:color, 'stroke-width':3, 'stroke-linecap':'round', 'stroke-linejoin':'round' }));
  for (const point of coordinates) view.append(svg('circle', { cx:point.x, cy:point.y, r:3, fill:color }));
  for (const index of [0, Math.floor((valid.length - 1) / 2), valid.length - 1]) {
    const label = svg('text', { x:coordinates[index].x, y:200, fill:'#607477', 'font-size':11, 'text-anchor':index === 0 ? 'start' : index === valid.length - 1 ? 'end' : 'middle' });
    label.textContent = dutchTime.format(new Date(valid[index].time));
    view.append(label);
  }
  container.append(view);
}

/** Vult kaarten en status in; input: statusobject; output: void. */
function renderStatus(status) {
  $('#now').textContent = dutchDay.format(new Date(status.time));
  $('#source').textContent = `Weerbron: ${status.weather.source}`;
  $('#sun').textContent = status.weather.sunrise ? `Zon ${dutchTime.format(new Date(status.weather.sunrise))}–${dutchTime.format(new Date(status.weather.sunset))}` : 'Zonuren: locatie ontbreekt';
  $('#pv-now').textContent = watts(status.growatt.power_w);
  const pvSource = { shinelink: 'ShineLink', cloud: 'Web-API', mixed: 'ShineLink + web-API' }[status.growatt.source];
  $('#pv-sub').textContent = `${status.growatt.active_inverters}/${status.growatt.expected_inverters} omvormers recent${pvSource ? ` · ${pvSource}` : ''}`;
  $('#net-now').textContent = watts(status.homewizard.net_power_w);
  const netPower = status.homewizard.net_power_w;
  $('#net-sub').textContent = !Number.isFinite(netPower) ? 'Geen recente netmeting' : netPower < 0 ? 'Teruglevering aan het net' : netPower > 0 ? 'Afname van het net' : 'Geen afname of teruglevering';
  $('#weather-interval').textContent = status.weather.poll_minutes === 0 ? 'Gepauzeerd' : `${status.weather.poll_minutes} min`;
  $('#next-fetch').textContent = status.weather.next_fetch ? `Volgende: ${dutchTime.format(new Date(status.weather.next_fetch))}` : 'Volgende: —';
}

/** Haalt huidige gegevens, grafieken en apparaatadviezen op; input: geen; output: Promise<void>. */
async function refresh() {
  try {
    const { status, forecasts, profiles, production, daily, cycles } = await json('/api/v1/dashboard');
    const forecast = forecasts.days[0];
    renderStatus(status);
    renderProductionDays(forecasts.days, production, status.baseload?.power_w ?? null);
    renderPvCorrection($('#pv-correction'), forecast.automatic_correction);
    const recent = production.points.at(-1);
    $('#chart-coverage').textContent = recent ? `${recent.active_inverters}/${recent.expected_inverters} omvormers` : '';
    const now = Date.parse(production.now);
    const upcoming = forecast.slots.filter((slot) => Date.parse(slot.end) > now && Date.parse(slot.start) < now + 3 * 3600000);
    drawChart($('#ghi-chart'), upcoming.map((slot) => ({ time:slot.time ?? slot.end, value:slot.ghi_w_m2 })), '#e6a321');
    $('#forecast-note').hidden = forecast.status === 'ok';
    $('#forecast-note').textContent = forecast.status === 'ok' ? '' : `Voorspelling: ${forecast.status}`;
    drawChart($('#history-chart'), production.points.map((point) => ({ time:point.time, value:point.power_w })), '#137771');
    renderDailyAdvice($('#appliance-list'), profiles.profiles, daily);
    renderApplianceCharts(cycles);
    $('#connection').textContent = 'Online';
  } catch (error) {
    $('#connection').textContent = `Kon gegevens niet ophalen: ${error.message}`;
  }
}

void refresh();
setInterval(() => { void refresh(); }, 30000);
