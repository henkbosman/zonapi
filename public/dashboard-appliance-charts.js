import { drawApplianceCycleChart, elapsedTime } from './appliance-cycle-chart.js';

const dateFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Maakt een veilig HTML-element met tekst; input: tag, klasse en tekst; output: DOM-element. */
function node(tag, className = '', text = '') {
  const result = document.createElement(tag); result.className = className; result.textContent = text; return result;
}

/** Beheert apparaatgrafieken, responsieve breedtes en de secondewijzer; input: container en optionele klok; output: renderfunctie met stop(). */
export function setupApplianceCharts(container, clock = Date.now) {
  let entries = [], receivedAt = 0, serverAt = 0;

  /** Werkt de voortgang bij zonder nieuwe API-aanvragen of hertekenen van alle meetpunten; input: geen; output: void. */
  function tick() {
    const passed = Math.max(0, (clock() - receivedAt) / 1000);
    for (const entry of entries) {
      const { data } = entry;
      if (!data.current) continue;
      const fresh = data.live && serverAt + passed * 1000 - Date.parse(data.activity.measured_at) <= data.fresh_seconds * 1000;
      const seconds = fresh ? data.elapsed_seconds + passed : data.current.state === 'active' ? data.current.points.at(-1)?.elapsed_seconds ?? 0 : data.elapsed_seconds;
      const prefix = data.current.state === 'completed' ? 'Duur' : fresh ? 'Verstreken' : 'Gemeten tot';
      entry.update(seconds, prefix);
      entry.progress.textContent = `${prefix} ${elapsedTime(seconds * 1000)}`;
    }
  }

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver((changes) => {
    for (const change of changes) {
      const entry = entries.find((item) => item.chart === change.target);
      if (entry && entry.width !== change.contentRect.width) {
        entry.width = change.contentRect.width;
        entry.update = drawApplianceCycleChart(entry.chart, entry.data);
      }
    }
    tick();
  }) : null;
  const timer = setInterval(tick, 1000);

  /** Toont één cache-snapshot van alle apparaatcycli; input: API-respons; output: void. */
  function render(snapshot) {
    observer?.disconnect(); container.replaceChildren(); entries = [];
    receivedAt = clock(); serverAt = Date.parse(snapshot.generated_at);
    for (const data of snapshot.appliances) {
      const card = node('article', 'chart-card appliance-chart-card');
      const heading = node('div', 'section-heading'), names = node('div');
      const caption = data.current ? `${data.current.state === 'active' ? 'Huidige cyclus' : 'Laatste cyclus'} · ${dateFormat.format(new Date(data.current.started_at))}` : 'Verbruik per cyclus';
      names.append(node('p', 'eyebrow', caption), node('h3', '', data.name));
      const progress = node('span', 'cycle-progress'); heading.append(names, progress);
      const chart = node('div', 'chart'), legend = node('div', 'chart-legend');
      for (const [className, text] of [['legend-measured', 'Gemeten verbruik'], ['legend-forecast', 'Vorige cyclus · verwachting']]) {
        const item = node('span'); item.append(node('i', className), node('span', '', text)); legend.append(item);
      }
      const note = node('p', 'chart-footer cycle-note');
      note.textContent = !data.current ? '' : !data.current.complete ? 'Deze cyclus is gedeeltelijk gemeten en wordt niet als verwachting gebruikt.'
        : !data.previous ? 'Na een volledig gemeten cyclus is er bij de volgende start een verwachting beschikbaar.'
          : `Verwachting gebaseerd op de cyclus van ${dateFormat.format(new Date(data.previous.started_at))}.`;
      if (data.current?.state === 'active' && !data.live) note.textContent = 'Geen actuele socketmeting. De voortgang staat op de laatste meting.';
      card.append(heading, chart, legend, note); container.append(card);
      const entry = { data, chart, progress, width: chart.clientWidth, update: drawApplianceCycleChart(chart, data) };
      entries.push(entry); observer?.observe(chart);
    }
    tick();
  }
  render.stop = () => { clearInterval(timer); observer?.disconnect(); };
  return render;
}
