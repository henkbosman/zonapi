import { attachTimeCursor } from './chart-cursor.js';
import { canConnectPoints, lineValueAt } from './production-chart-series.js';

/** Formatteert verstreken milliseconden zonder tijdzone of kalender; input: ms; output: uu:mm:ss. */
export function elapsedTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Maakt een veilig SVG-element; input: tag en attributen; output: SVG-element. */
function node(tag, attributes = {}) {
  const result = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) result.setAttribute(name, String(value));
  return result;
}

/** Schrijft een leesbaar grafieklabel; input: SVG, inhoud, plaats en anker; output: tekstnode. */
function label(svg, content, x, y, anchor = 'middle', fill = '#607477') {
  const result = node('text', { x, y, 'text-anchor': anchor, fill, 'font-size': 12 });
  result.textContent = content; svg.append(result); return result;
}

/** Kiest vermogen tegen verstreken tijd; input: cyclus of null; output: geordende geldige meetpunten. */
function points(run) {
  return (run?.points ?? []).filter((point) => Number.isFinite(point.elapsed_seconds) && point.elapsed_seconds >= 0 && Number.isFinite(point.power_w))
    .map((point) => ({ ms: point.elapsed_seconds * 1000, value: point.power_w })).sort((a, b) => a.ms - b.ms);
}

/** Verbindt meetpunten en laat meetgaten open; input: SVG, punten, projecties, kleur en maximale meetpauze; output: void. */
function drawLine(svg, values, x, y, color, maxGapMs) {
  if (!values.length) return;
  const d = values.map((point, index) => `${canConnectPoints(values[index - 1], point, maxGapMs) ? 'L' : 'M'}${x(point.ms).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
  svg.append(node('path', { d, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  for (const [index, point] of values.entries()) {
    if (!canConnectPoints(values[index - 1], point, maxGapMs) && !canConnectPoints(point, values[index + 1], maxGapMs)) {
      svg.append(node('circle', { cx: x(point.ms), cy: y(point.value), r: 4, fill: color }));
    }
  }
}

/** Tekent de actieve/laatste cyclus en vorige cyclus op dezelfde verstreken tijdas; input: container, apparaatgrafiek en verstreken seconden; output: updater voor de voortgangslijn. */
export function drawApplianceCycleChart(container, data, elapsedSeconds = data.elapsed_seconds) {
  container.replaceChildren();
  if (!data.current) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = data.configured ? 'Nog geen cyclus gemeten. De grafiek verschijnt zodra het apparaat draait.' : 'Stel voor dit apparaat een Energy Socket in om het verbruik te meten.';
    container.append(empty); return () => {};
  }
  const measured = points(data.current), expected = points(data.previous);
  const width = Math.max(280, container.clientWidth || 780), height = 360;
  const left = 56, right = width - 18, top = 36, bottom = height - 48;
  const end = Math.max(60000, data.current.duration_seconds * 1000, (data.previous?.duration_seconds ?? 0) * 1000, (elapsedSeconds ?? 0) * 1000);
  const maximum = Math.max(500, Math.ceil(Math.max(0, ...measured.map((point) => point.value), ...expected.map((point) => point.value)) / 500) * 500);
  const x = (ms) => left + (right - left) * Math.min(end, Math.max(0, ms)) / end;
  const y = (power) => bottom - (bottom - top) * power / maximum;
  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'group', preserveAspectRatio: 'xMinYMin meet',
    'aria-label': `Verbruik van ${data.name}, tijd sinds de start van de cyclus` });
  for (let index = 0; index <= 3; index++) {
    const yy = y(maximum * index / 3);
    svg.append(node('line', { x1: left, x2: right, y1: yy, y2: yy, stroke: '#e4ece8' }));
    label(svg, `${Math.round(maximum * index / 300) / 10} kW`, left - 7, yy + 4, 'end');
  }
  for (const fraction of end < 300000 ? [0, .5, 1] : [0, .25, .5, .75, 1]) {
    const value = end * fraction, minutes = Math.round(value / 60000);
    const text = end < 300000 ? `${Math.round(value / 1000)} s` : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}u${String(minutes % 60).padStart(2, '0')}`;
    label(svg, text, x(value), height - 12, fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle');
  }
  const measuredGap = data.current.max_gap_seconds * 1000, expectedGap = (data.previous?.max_gap_seconds ?? 120) * 1000;
  drawLine(svg, expected, x, y, '#e6a321', expectedGap);
  drawLine(svg, measured, x, y, '#137771', measuredGap);
  const marker = node('line', { y1: top, y2: bottom, stroke: '#172629', 'stroke-width': 1.5, 'stroke-dasharray': '5 4', 'data-cycle-progress': '' });
  svg.append(marker);
  const progress = label(svg, '', left, 16, 'start', '#172629');
  progress.setAttribute('data-cycle-elapsed', '');
  attachTimeCursor(svg, { start: 0, end, left, right, top, bottom, width, formatTime: elapsedTime,
    ariaLabel: 'Tijd sinds de start van het apparaat', stepMs: 60000, labelWidth: 88 }, [
    { label: 'Gemeten', color: '#137771', valueAt: (ms) => lineValueAt(measured, ms, measuredGap) },
    { label: 'Vorige cyclus', color: '#996200', valueAt: (ms) => lineValueAt(expected, ms, expectedGap) }
  ]);
  container.append(svg);

  /** Verplaatst uitsluitend de voortgangslijn en de verstreken tijd; input: seconden en label; output: void. */
  function updateElapsed(seconds, prefix = 'Verstreken') {
    const ms = Math.max(0, seconds ?? 0) * 1000, xx = x(ms);
    marker.setAttribute('x1', xx); marker.setAttribute('x2', xx);
    progress.setAttribute('x', Math.max(left, Math.min(right - 170, xx - 85)));
    progress.textContent = `${prefix} ${elapsedTime(ms)}`;
  }
  updateElapsed(elapsedSeconds, data.current.state === 'completed' ? 'Duur' : data.live ? 'Verstreken' : 'Gemeten tot');
  return updateElapsed;
}
