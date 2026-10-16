const ns = 'http://www.w3.org/2000/svg';
const hour = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });

/** Maakt één SVG-element met tekst of attributen; input: naam, eigenschappen en parent; output: nieuw SVG-element. */
function svgNode(name, attributes, parent) {
  const node = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent.append(node);
  return node;
}

/** Tekent een instralingsreeks uit opgeslagen tijdvakken; input: forecast uit /api/v1/weather, huidige ms en container; output: void. */
export function drawRadiationChart(forecast, now, container) {
  container.replaceChildren();
  const sunrise = Date.parse(forecast.sunrise);
  const sunset = Date.parse(forecast.sunset);
  const rows = forecast.rows ?? [];
  if (!Number.isFinite(sunrise) || !Number.isFinite(sunset) || sunset <= sunrise || !rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Geen instralingsgegevens voor vandaag';
    container.append(empty);
    return;
  }
  const chart = svgNode('svg', { viewBox: '0 0 940 245', 'aria-hidden': 'true' }, container);
  const left = 54, right = 925, top = 13, bottom = 205;
  const maximum = Math.max(100, Math.ceil(Math.max(...rows.flatMap((row) => [row.ghi_w_m2, row.dni_w_m2, row.dhi_w_m2])) / 100) * 100);
  const x = (time) => left + Math.max(0, Math.min(1, (time - sunrise) / (sunset - sunrise))) * (right - left);
  const y = (value) => bottom - Math.max(0, value) / maximum * (bottom - top);
  for (const value of [0, maximum / 2, maximum]) {
    const ordinate = y(value);
    svgNode('line', { x1: left, x2: right, y1: ordinate, y2: ordinate, stroke: '#e5eae7' }, chart);
    const label = svgNode('text', { x: left - 8, y: ordinate + 4, 'text-anchor': 'end', class: 'axis-label' }, chart);
    label.textContent = String(Math.round(value));
  }
  for (const [time, anchor] of [[sunrise, 'start'], [(sunrise + sunset) / 2, 'middle'], [sunset, 'end']]) {
    const label = svgNode('text', { x: x(time), y: 232, 'text-anchor': anchor, class: 'axis-label' }, chart);
    label.textContent = hour.format(time);
  }
  for (const [field, color] of [['ghi_w_m2', '#daa21c'], ['dni_w_m2', '#137771'], ['dhi_w_m2', '#738ebd']]) {
    const points = forecastLinePoints(rows.map((row) => ({ ...row, power_w: row[field] })), sunrise, sunset);
    if (!points.length) continue;
    svgNode('path', { d: points.map((point, index) => `${canConnectPoints(points[index - 1], point, 75 * 60000) ? 'L' : 'M'}${x(point.ms).toFixed(1)},${y(point.value).toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, chart);
  }
  if (now >= sunrise && now <= sunset) svgNode('line', { x1: x(now), x2: x(now), y1: top, y2: bottom, stroke: '#273737', 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }, chart);
}
import { forecastLinePoints, canConnectPoints } from './production-chart-series.js';

