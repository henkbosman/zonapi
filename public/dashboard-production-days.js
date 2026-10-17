import { drawProductionChart } from './dashboard-production-chart.js';

const dayLabel = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short' });

/** Beheert de drie daggrafieken en hertekent bij breedtewijzigingen; input: geen; output: renderfunctie voor dagvoorspellingen en metingen van vandaag. */
export function setupProductionDayCharts() {
  const containers = ['pv-chart', 'pv-chart-tomorrow', 'pv-chart-after-tomorrow'].map((id) => document.getElementById(id));
  let days = [], production = null, baseloadW = null;

  /** Tekent de beschikbare dagvoorspellingen met hun eigen daglichtgrenzen; input: geen; output: void. */
  function draw() {
    for (let index = 0; index < containers.length; index++) {
      const forecast = days[index];
      if (!forecast) continue;
      const day = index === 0 ? { ...production, sunrise: forecast.sunrise, sunset: forecast.sunset } : { ...forecast, points: [] };
      drawProductionChart(containers[index], day, forecast.slots, { forecastOnly: index > 0, baseloadW });
      const legend = document.getElementById(`pv-baseload-${index}`);
      if (legend) legend.textContent = Number.isFinite(baseloadW) ? `Basislast · ${Math.round(baseloadW)} W` : 'Basislast ontbreekt';
      document.getElementById(`pv-date-${index}`).textContent = dayLabel.format(new Date(`${forecast.date}T12:00:00Z`));
      if (index > 0) {
        const note = document.getElementById(`forecast-note-${index}`);
        note.hidden = forecast.status === 'ok';
        note.textContent = forecast.status === 'ok' ? '' : `Voorspelling: ${forecast.status}`;
      }
    }
  }

  if (typeof ResizeObserver === 'function') {
    const widths = new Map();
    const observer = new ResizeObserver((entries) => {
      const changed = entries.some((entry) => widths.get(entry.target) !== entry.contentRect.width);
      for (const entry of entries) widths.set(entry.target, entry.contentRect.width);
      if (changed) draw();
    });
    for (const container of containers) observer.observe(container);
  }

  /** Actualiseert grafieken uit één API-snapshot; input: drie dagvoorspellingen, actuele dagmetingen en basislast in watt; output: void. */
  function render(nextDays, nextProduction, nextBaseloadW = null) { days = nextDays; production = nextProduction; baseloadW = nextBaseloadW; draw(); }

  return render;
}
