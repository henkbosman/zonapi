const timeFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });

/** Maakt een element binnen een SVG-grafiek; input: tag en attributen; output: SVG-element. */
function node(tag, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

/** Voegt een aanwijsbare tijdcursor toe; input: SVG en tijd-/plotgrenzen; output: void. */
export function attachTimeCursor(svg, { start, end, left, right, top, bottom, width }) {
  const cursor = node('g', { visibility: 'hidden', 'pointer-events': 'none', 'data-chart-cursor': '' });
  const line = node('line', { y1: top, y2: bottom, stroke: '#172629', 'stroke-width': 1.2 });
  const background = node('rect', { y: bottom + 3, width: 56, height: 22, rx: 5, fill: '#172629' });
  const text = node('text', { y: bottom + 18, fill: '#fff', 'font-size': 12, 'text-anchor': 'middle' });
  cursor.append(line, background, text);
  const target = node('rect', { x: left, y: top, width: right - left, height: bottom - top, fill: 'transparent', tabindex: 0,
    role: 'slider', 'aria-label': 'Tijd in zonopbrengstgrafiek', 'aria-valuemin': start, 'aria-valuemax': end });
  let time = start;

  /** Plaatst cursor en tijdlabel binnen de dagas; input: epoch-ms; output: void. */
  function show(ms) {
    time = Math.min(end, Math.max(start, ms));
    const x = left + (time - start) / (end - start) * (right - left);
    const center = Math.max(left + 28, Math.min(right - 28, x));
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    background.setAttribute('x', center - 28); text.setAttribute('x', center);
    text.textContent = timeFormat.format(new Date(time));
    target.setAttribute('aria-valuenow', Math.round(time));
    target.setAttribute('aria-valuetext', text.textContent);
    cursor.setAttribute('visibility', 'visible');
  }

  target.addEventListener('pointermove', (event) => {
    const bounds = svg.getBoundingClientRect();
    if (!bounds.width) return;
    const x = (event.clientX - bounds.left) / bounds.width * width;
    show(start + (x - left) / (right - left) * (end - start));
  });
  target.addEventListener('pointerleave', () => cursor.setAttribute('visibility', 'hidden'));
  target.addEventListener('focus', () => show(time));
  target.addEventListener('blur', () => cursor.setAttribute('visibility', 'hidden'));
  target.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    show(event.key === 'Home' ? start : event.key === 'End' ? end : time + (event.key === 'ArrowLeft' ? -1 : 1) * 5 * 60000);
  });
  svg.append(target, cursor);
}
