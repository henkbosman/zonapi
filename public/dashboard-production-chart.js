import { attachTimeCursor } from './chart-cursor.js';
import { forecastLinePoints, lineValueAt, canConnectPoints, clockAxisTicks, blockCorrectionAt } from './production-chart-series.js';

const timeLabel = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
const preciseTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const baseColor = '#efd7a2';

/** Toont de automatische afwijking ten opzichte van de basisvoorspelling; input: percentage; output: tekst met teken. */
function correctionLabel(percent) {
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%`;
}

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
function drawLine(svg, points, x, y, color, maxGapMs, { base = false } = {}) {
  if (!points.length) return;
  let path = '';
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    path += `${canConnectPoints(points[i - 1], point, maxGapMs) ? 'L' : 'M'}${x(point.ms).toFixed(1)},${y(point.value).toFixed(1)} `;
  }
  svg.append(node('path', { d: path.trim(), fill: 'none', stroke: color, 'stroke-width': base ? 2 : 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  for (const point of points) {
    if (point.synthetic) continue;
    const circle = node('circle', { cx: x(point.ms), cy: y(point.value), r: points.length === 1 ? 5 : base ? 2.5 : 3.5, fill: color,
      'data-time': new Date(point.ms).toISOString(), 'data-point-kind': point.count ? 'measurement' : 'interval_mean',
      'data-series': point.count ? 'measured' : base ? 'base_forecast' : 'forecast' });
    const title = node('title');
    if (point.count) {
      const span = point.measuredFrom && point.measuredFrom !== point.ms ? ` · Metingen ${preciseTime.format(new Date(point.measuredFrom))}–${preciseTime.format(new Date(point.ms))}` : '';
      title.textContent = `${preciseTime.format(new Date(point.ms))} · ${Math.round(point.value)} W · ${point.count}/${point.expected} omvormers${span}`;
    } else {
      circle.setAttribute('data-interval-start', new Date(point.interval_start_ms).toISOString());
      circle.setAttribute('data-interval-end', new Date(point.interval_end_ms).toISOString());
      const source = point.source_resolution_minutes > (point.interval_end_ms - point.interval_start_ms) / 60000 ? ` · bron ${point.source_resolution_minutes} min` : '';
      const correction = !base && Number.isFinite(point.correction_factor) ? ` · Correctie ${correctionLabel((point.correction_factor - 1) * 100)}` : '';
      title.textContent = `${timeLabel.format(new Date(point.ms))} · ${Math.round(point.value)} W${base ? ' · Zonder correctie' : ''}${correction} · Gemiddelde ${timeLabel.format(new Date(point.sample_start_ms))}–${timeLabel.format(new Date(point.sample_end_ms))}${source}`;
    }
    circle.append(title);
    svg.append(circle);
  }
}

/** Tekent een ruime daggrafiek binnen de zonuren; input: container, dagdata, voorspelslots en optioneel forecastOnly/baseloadW; output: void met basislast en tijd-/waardecursor. */
export function drawProductionChart(container, day, slots, { forecastOnly = false, baseloadW = null } = {}) {
  container.replaceChildren();
  const now = Date.parse(day.now);
  const sunrise = Date.parse(day.sunrise), sunset = Date.parse(day.sunset);
  const daylight = Number.isFinite(sunrise) && Number.isFinite(sunset) && sunset > sunrise;
  if (!daylight) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Zontijden ontbreken';
    container.append(empty); return;
  }
  const start = sunrise, end = sunset;
  const measured = (forecastOnly ? [] : day.points).filter((point) => point.active_inverters === point.expected_inverters && Number.isFinite(point.power_w) && Date.parse(point.time) >= start && Date.parse(point.time) <= end)
    .map((point) => ({ ms: Date.parse(point.time), value: point.power_w, count: point.active_inverters, expected: point.expected_inverters,
      measuredFrom: Date.parse(point.measured_from ?? point.time) }))
    .sort((a, b) => a.ms - b.ms);
  const forecast = forecastLinePoints(slots, start, end);
  const baseForecast = forecastLinePoints(slots.map((slot) => ({ ...slot, power_w: slot.base_power_w })), start, end);
  const hasCorrection = slots.some((slot) => Number.isFinite(slot.power_w) && Number.isFinite(slot.automatic_correction_factor));
  const width = Math.max(280, container.clientWidth || 780), height = 360;
  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, width, height, preserveAspectRatio: 'xMinYMin meet', role: 'group',
    'aria-label': forecastOnly ? 'Voorspelde zonopbrengst tussen zonsopkomst en zonsondergang' : 'Gemeten en voorspelde zonopbrengst tussen zonsopkomst en zonsondergang' });
  const left = 52, right = width - 18, top = 24, bottom = height - 48;
  const hasBaseload = Number.isFinite(baseloadW) && baseloadW >= 0;
  const maxPower = Math.max(500, Math.ceil(Math.max(hasBaseload ? baseloadW : 0, ...measured.map((point) => point.value), ...forecast.map((point) => point.value), ...baseForecast.map((point) => point.value)) / 500) * 500);
  const x = (ms) => left + (right - left) * (ms - start) / (end - start);
  const y = (value) => bottom - (bottom - top) * value / maxPower;
  for (let i = 0; i <= 3; i++) {
    const yy = bottom - (bottom - top) * i / 3;
    svg.append(node('line', { x1: left, x2: right, y1: yy, y2: yy, stroke: '#e4ece8' }));
    label(svg, `${Math.round(maxPower * i / 300) / 10} kW`, 45, yy + 4, 'end');
  }
  for (let ms = Math.ceil(start / 900000) * 900000; ms < end; ms += 900000) {
    svg.append(node('line', { x1: x(ms), x2: x(ms), y1: top, y2: bottom,
      stroke: ms % 3600000 === 0 ? '#e4ece8' : '#f0f4f1', 'data-clock-quarter': new Date(ms).toISOString() }));
  }
  for (const ms of clockAxisTicks(start, end, right - left)) {
    label(svg, timeLabel.format(new Date(ms)), x(ms), height - 12, ms === start ? 'start' : ms === end ? 'end' : 'middle');
  }
  drawLine(svg, baseForecast, x, y, baseColor, 75 * 60000, { base: true });
  drawLine(svg, measured, x, y, '#137771', Infinity);
  drawLine(svg, forecast, x, y, '#e6a321', 75 * 60000);
  if (hasBaseload) {
    const line = node('line', { x1: left, x2: right, y1: y(baseloadW), y2: y(baseloadW), stroke: '#c64040', 'stroke-width': 2,
      'data-baseload-w': baseloadW });
    const title = node('title'); title.textContent = `Basislast: ${Math.round(baseloadW)} W`; line.append(title); svg.append(line);
  }
  if (!measured.length && !forecast.length) label(svg, forecastOnly ? 'Geen voorspelling' : 'Geen meetpunten', (left + right) / 2, (top + bottom) / 2);
  if (now >= start && now <= end) {
    const nowX = x(now);
    svg.append(node('line', { x1: nowX, x2: nowX, y1: top, y2: bottom, stroke: '#172629', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
    label(svg, 'Nu', Math.min(right - 12, Math.max(left + 12, nowX)), 14);
  }
  attachTimeCursor(svg, { start, end, left, right, top, bottom, width, formatTime: (ms) => preciseTime.format(new Date(ms)), labelWidth: 82, stepMs: 900000 }, [
    ...(forecastOnly ? [] : [{ label: 'Gemeten', color: '#137771', valueAt: (ms) => lineValueAt(measured, ms, Infinity) }]),
    { label: 'Voorspelling', color: '#996200', valueAt: (ms) => lineValueAt(forecast, ms, 75 * 60000) },
    ...(baseForecast.length ? [{ label: 'Zonder correctie', color: '#8c7445', valueAt: (ms) => lineValueAt(baseForecast, ms, 75 * 60000) }] : []),
    ...(hasCorrection ? [{ label: 'Correctie', color: '#996200', valueAt: (ms) => blockCorrectionAt(slots, ms), formatValue: correctionLabel }] : []),
    ...(hasBaseload ? [{ label: 'Basislast', color: '#c64040', valueAt: () => baseloadW }] : [])
  ]);
  container.append(svg);
}
