const timeFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });

/** Maakt een element binnen een SVG-grafiek; input: tag en attributen; output: SVG-element. */
function node(tag, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

/** Voegt een aanwijsbare tijd- en waardecursor toe; input: SVG, tijd-/plotgrenzen en {label,color,valueAt,formatValue?,multiline?}[]; output: void. */
export function attachTimeCursor(svg, { start, end, left, right, top, bottom, width,
  formatTime = (ms) => timeFormat.format(new Date(ms)), ariaLabel = 'Tijd in zonopbrengstgrafiek', stepMs = 5 * 60000, labelWidth = 56, viewport = null }, series = []) {
  const cursor = node('g', { visibility: 'hidden', 'pointer-events': 'none', 'data-chart-cursor': '' });
  const line = node('line', { y1: top, y2: bottom, stroke: '#172629', 'stroke-width': 1.2 });
  const background = node('rect', { y: bottom + 3, width: labelWidth, height: 22, rx: 5, fill: '#172629' });
  const text = node('text', { y: bottom + 18, fill: '#fff', 'font-size': 12, 'text-anchor': 'middle' });
  cursor.append(line, background, text);
  const values = node('g', { 'data-chart-values': '' });
  const viewportWidth = viewport?.clientWidth || width;
  const boxWidth = Math.min(224, right - left - 10, Math.max(70, viewportWidth - left - 10));
  const box = node('rect', { width: boxWidth, height: 14 + series.reduce((sum, item) => sum + (item.multiline ? 42 : 23), 0), rx: 8, fill: '#fff', stroke: '#dce8e3', 'stroke-width': 1.2 });
  values.append(box);
  const rows = series.map((item) => {
    const row = node('text', { fill: item.color, 'font-size': boxWidth < 204 ? 12 : 13, 'font-weight': 600 });
    values.append(row);
    const detail = item.multiline ? node('text', { fill: item.color, 'font-size': boxWidth < 204 ? 12 : 13, 'font-weight': 500 }) : null;
    if (detail) values.append(detail);
    return { row, detail };
  });
  if (series.length) cursor.append(values);
  const target = node('rect', { x: left, y: top, width: right - left, height: bottom - top, fill: 'transparent', 'pointer-events': 'none', tabindex: 0,
    role: 'slider', 'aria-label': ariaLabel, 'aria-valuemin': start, 'aria-valuemax': end });
  let time = start;

  /** Plaatst cursor, tijd en waarden op de getekende lijnen; input: epoch-ms; output: void. */
  function show(ms, scrollIntoView = false) {
    time = Math.round(Math.min(end, Math.max(start, ms)));
    const x = left + (time - start) / (end - start) * (right - left);
    if (viewport && scrollIntoView && (x < (viewport.scrollLeft || 0) + 12 || x > (viewport.scrollLeft || 0) + viewportWidth - 12)) {
      viewport.scrollLeft = Math.max(0, Math.min(width - viewportWidth, x - viewportWidth / 2));
    }
    const visibleLeft = Math.max(left, viewport?.scrollLeft || 0), visibleRight = Math.min(right, (viewport?.scrollLeft || 0) + viewportWidth);
    const center = Math.max(visibleLeft + labelWidth / 2, Math.min(visibleRight - labelWidth / 2, x));
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    background.setAttribute('x', center - labelWidth / 2); text.setAttribute('x', center);
    text.textContent = formatTime(time);
    const boxX = Math.max(visibleLeft + 5, Math.min(visibleRight - boxWidth - 5, x + 12 > visibleRight - boxWidth ? x - boxWidth - 12 : x + 12));
    box.setAttribute('x', boxX); box.setAttribute('y', top + 7);
    let offset = 0;
    const descriptions = [];
    for (const [index, item] of series.entries()) {
      const value = item.valueAt(time);
      const formatted = Number.isFinite(value) ? item.formatValue ? item.formatValue(value) : `${Math.round(value).toLocaleString('nl-NL')} W` : '—';
      const { row, detail } = rows[index];
      row.setAttribute('x', boxX + 12); row.setAttribute('y', top + 31 + offset);
      row.textContent = `${item.label}:${detail ? '' : ` ${formatted}`}`;
      if (detail) { detail.setAttribute('x', boxX + 12); detail.setAttribute('y', top + 49 + offset); detail.textContent = formatted; }
      descriptions.push(`${item.label}: ${formatted}`);
      offset += detail ? 42 : 23;
    }
    target.setAttribute('aria-valuenow', Math.round(time));
    target.setAttribute('aria-valuetext', [text.textContent, ...descriptions].join(', '));
    cursor.setAttribute('visibility', 'visible');
  }

  const move = (event) => {
    const bounds = svg.getBoundingClientRect();
    if (!bounds.width) return;
    const x = (event.clientX - bounds.left) / bounds.width * width;
    show(start + (x - left) / (right - left) * (end - start));
  };
  // De cursor mag SVG-punten niet afdekken: hun eigen tooltip bevat de echte meettijd en tijdvakgrenzen.
  for (const receiver of [svg, target]) {
    receiver.addEventListener('pointermove', move);
    receiver.addEventListener('pointerleave', () => cursor.setAttribute('visibility', 'hidden'));
  }
  target.addEventListener('focus', () => show(time, true));
  target.addEventListener('blur', () => cursor.setAttribute('visibility', 'hidden'));
  target.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    show(event.key === 'Home' ? start : event.key === 'End' ? end : time + (event.key === 'ArrowLeft' ? -1 : 1) * stepMs, true);
  });
  svg.append(target, cursor);
}
