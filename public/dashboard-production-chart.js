import { attachTimeCursor } from './chart-cursor.js';
import { forecastLinePoints, lineValueAt, canConnectPoints } from './production-chart-series.js';

const timeLabel = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });

/** Bouwt een veilig SVG-element; input: tag en attributen; output: SVG-element. */
function node(tag, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/** Schrijft een tekstlabel in de daggrafiek; input: SVG, tekst, x/y en tekstanker; output: void. */
function label(svg, content, x, y, anchor = 'middle') {
  const text = node('text', { x, y, 'text-anchor': anchor, fill: '#607477', 'font-size': 12 });
  text.textContent = content;
  svg.append(text);
}

/** Plaatst meetpunten op één tijdas en onderbreekt lijnen na een meetgat; input: SVG, punten, projecties, kleur, maximale tussentijd; output: void. */
function drawLine(svg, points, x, y, color, maxGapMs) {
  if (!points.length) return;
  let path = '';
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    path += `${canConnectPoints(points[i - 1], point, maxGapMs) ? 'L' : 'M'}${x(point.ms).toFixed(1)},${y(point.value).toFixed(1)} `;
  }
  svg.append(node('path', { d: path.trim(), fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  for (const point of points) {
    const circle = node('circle', { cx: x(point.ms), cy: y(point.value), r: points.length === 1 ? 5 : 3.5, fill: color });
    const title = node('title');
    title.textContent = `${timeLabel.format(new Date(point.ms))} · ${Math.round(point.value)} W${point.count ? ` · ${point.count}/${point.expected} omvormers` : ''}`;
    circle.append(title);
    svg.append(circle);
  }
}

/** Tekent verbonden totaalmomenten en de volledige dagvoorspelling binnen de zonuren; input: container, dagdata en voorspelslots; output: void. */
export function drawProductionChart(container, day, slots) {
  container.replaceChildren();
  const now = Date.parse(day.now);
  const sunrise = Date.parse(day.sunrise), sunset = Date.parse(day.sunset);
  const daylight = Number.isFinite(sunrise) && Number.isFinite(sunset) && sunset > sunrise;
  if (!daylight) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Zontijden ontbreken';
    container.append(empty); return;
  }
  const start = sunrise, end = sunset;
  const measured = day.points.filter((point) => point.active_inverters === point.expected_inverters && Number.isFinite(point.power_w) && Date.parse(point.time) >= start && Date.parse(point.time) <= end)
    .map((point) => ({ ms: Date.parse(point.time), value: point.power_w, count: point.active_inverters, expected: point.expected_inverters }))
    .sort((a, b) => a.ms - b.ms);
  const forecast = forecastLinePoints(slots, start, end);
  const svg = node('svg', { viewBox: '0 0 780 255', preserveAspectRatio: 'none', role: 'group', 'aria-label': 'Gemeten en voorspelde zonopbrengst tussen zonsopkomst en zonsondergang' });
  const left = 52, right = 762, top = 20, bottom = 207;
  const maxPower = Math.max(500, Math.ceil(Math.max(0, ...measured.map((point) => point.value), ...forecast.map((point) => point.value)) / 500) * 500);
  const x = (ms) => left + (right - left) * (ms - start) / (end - start);
  const y = (value) => bottom - (bottom - top) * value / maxPower;
  for (let i = 0; i <= 3; i++) {
    const yy = bottom - (bottom - top) * i / 3;
    svg.append(node('line', { x1: left, x2: right, y1: yy, y2: yy, stroke: '#e4ece8' }));
    label(svg, `${Math.round(maxPower * i / 300) / 10} kW`, 45, yy + 4, 'end');
  }
  for (const fraction of [0, .25, .5, .75, 1]) {
    const ms = start + (end - start) * fraction;
    label(svg, timeLabel.format(new Date(ms)), x(ms), 243, fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle');
  }
  drawLine(svg, measured, x, y, '#137771', Infinity);
  drawLine(svg, forecast, x, y, '#e6a321', 75 * 60000);
  if (!measured.length && !forecast.length) label(svg, 'Geen meetpunten', (left + right) / 2, (top + bottom) / 2);
  if (now >= start && now <= end) {
    const nowX = x(now);
    svg.append(node('line', { x1: nowX, x2: nowX, y1: top, y2: bottom, stroke: '#172629', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
    label(svg, 'Nu', Math.min(right - 12, Math.max(left + 12, nowX)), 14);
  }
  attachTimeCursor(svg, { start, end, left, right, top, bottom, width: 780 }, [
    { label: 'Gemeten', color: '#137771', valueAt: (ms) => lineValueAt(measured, ms, Infinity) },
    { label: 'Voorspelling', color: '#996200', valueAt: (ms) => lineValueAt(forecast, ms, 75 * 60000) }
  ]);
  container.append(svg);
}
