/** Zoekt één dashboardelement; input: CSS-selector; output: Element of null. */
const $ = (selector) => document.querySelector(selector);
const dutchTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
const dutchDay = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
let hours = 3;

/** Leest één endpoint met expliciete foutstatus; input: pad; output: Promise<JSON> of fout. */
async function json(path) {
  const response = await fetch(path);
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

/** Toont één machine en zijn volledige-cyclusadvies; input: profiel en adviesobject; output: void. */
function showAppliance(profile, advice) {
  const card = document.createElement('article'); card.className = 'appliance';
  const title = document.createElement('h3'); title.textContent = profile.name;
  const sub = document.createElement('p'); sub.textContent = `Cyclus: ${profile.duration_minutes} min`;
  const time = document.createElement('div'); time.className = 'time';
  const details = document.createElement('p');
  const badge = document.createElement('span'); badge.className = 'badge';
  if (advice.status === 'ok' && advice.earliest_start) {
    time.textContent = dutchDay.format(new Date(advice.earliest_start));
    details.textContent = `Eigen zon: ${advice.earliest.solar_share_percent}% · minimum: ${advice.minimum_solar_share_percent}%`;
    badge.textContent = advice.can_start_now ? 'Nu starten kan' : 'Eerstvolgend startmoment';
  } else if (advice.status === 'ok' && advice.best) {
    time.textContent = 'Geen passend moment';
    details.textContent = `Beste optie: ${dutchDay.format(new Date(advice.best_start))} · eigen zon: ${advice.best.solar_share_percent}%`;
    badge.textContent = 'Onder jouw drempel';
  } else {
    time.textContent = advice.status === 'stale' ? 'Voorspelling verouderd' : 'Nog geen advies';
    details.textContent = (advice.missing ?? []).join('; ');
    badge.textContent = advice.status === 'stale' ? 'Weerdata verouderd' : advice.status === 'insufficient_baseload' ? 'Basislast ontbreekt' : 'Onvoldoende data';
  }
  card.append(title, sub, time);
  if (details.textContent) card.append(details);
  card.append(badge);
  $('#appliance-list').append(card);
}

/** Vult kaarten en status in; input: statusobject; output: void. */
function renderStatus(status) {
  $('#now').textContent = dutchDay.format(new Date(status.time));
  $('#source').textContent = `Weerbron: ${status.weather.source}`;
  $('#sun').textContent = status.weather.sunrise ? `Zon ${dutchTime.format(new Date(status.weather.sunrise))}–${dutchTime.format(new Date(status.weather.sunset))}` : 'Zonuren: locatie ontbreekt';
  $('#pv-now').textContent = watts(status.growatt.power_w);
  $('#pv-sub').textContent = `${status.growatt.active_inverters}/${status.growatt.expected_inverters} omvormers recent`;
  $('#net-now').textContent = watts(status.homewizard.net_power_w);
  $('#net-sub').textContent = status.homewizard.selected_device ? status.homewizard.selected_device.toUpperCase() : 'Geen recente netmeting';
  $('#quota').textContent = `${status.weather.used_requests} / ${status.weather.max_requests}`;
  $('#next-fetch').textContent = status.weather.next_fetch ? `Volgende: ${dutchTime.format(new Date(status.weather.next_fetch))}` : 'Volgende: —';
  const problems = [ ...(status.panels.missing ?? []), ...(status.weather.location_configured ? [] : ['Locatie ontbreekt']), ...(status.weather.last_error ? [`Weerbron: ${status.weather.last_error}`] : []), ...Object.entries(status.homewizard.errors).filter(([, error]) => error).map(([key, error]) => `${key}: ${error}`) ];
  const health = $('#health'); health.replaceChildren();
  health.hidden = problems.length === 0;
  if (problems.length) {
    const heading = document.createElement('h2'); heading.textContent = 'Aandachtspunten';
    const list = document.createElement('ul');
    for (const problem of problems) { const item = document.createElement('li'); item.textContent = problem; list.append(item); }
    health.append(heading, list);
  }
}

/** Haalt huidige gegevens, grafieken en apparaatadviezen op; input: geen; output: Promise<void>. */
async function refresh() {
  try {
    const [status, forecast, profiles, history] = await Promise.all([
      json('/api/v1/status'), json(`/api/v1/forecast?hours=${hours}`), json('/api/v1/appliances'), json('/api/v1/history?metric=inverter&limit=5000')
    ]);
    renderStatus(status);
    drawChart($('#pv-chart'), forecast.slots.map((slot) => ({ time:slot.start, value:slot.power_w })), '#137771');
    drawChart($('#ghi-chart'), forecast.slots.map((slot) => ({ time:slot.start, value:slot.ghi_w_m2 })), '#e6a321');
    $('#forecast-note').hidden = forecast.status === 'ok';
    $('#forecast-note').textContent = forecast.status === 'ok' ? '' : `Voorspelling: ${forecast.status}`;
    const buckets = new Map();
    for (const row of history.rows) {
      const key = Math.floor(row.measured_ms / 300000);
      if (!buckets.has(key)) buckets.set(key, new Map());
      buckets.get(key).set(row.serial, row.power_w);
    }
    drawChart($('#history-chart'), [...buckets].filter(([, values]) => values.size === status.growatt.expected_inverters).map(([key, values]) => ({ time:new Date(key * 300000).toISOString(), value:[...values.values()].reduce((total, item) => total + item, 0) })), '#137771');
    $('#appliance-list').replaceChildren();
    const advice = await Promise.all(profiles.profiles.map((profile) => json(`/api/v1/appliances/${profile.id}/advice`).then((result) => ({ profile, result }))));
    for (const item of advice) showAppliance(item.profile, item.result);
    $('#connection').textContent = 'Online';
  } catch (error) {
    $('#connection').textContent = `Kon gegevens niet ophalen: ${error.message}`;
  }
}

/** Wisselt voorspellingvenster en vernieuwt grafieken; input: muisklik-event; output: void. */
function chooseHours(event) {
  const button = event.target.closest('[data-hours]');
  if (!button) return;
  hours = Number(button.dataset.hours);
  document.querySelectorAll('[data-hours]').forEach((item) => item.classList.toggle('active', item === button));
  void refresh();
}

document.querySelector('.segmented').addEventListener('click', chooseHours);
void refresh();
setInterval(() => { void refresh(); }, 30000);
