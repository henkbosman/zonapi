const dayFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
const statuses = {
  stale: 'Verwachting verouderd', configuration_incomplete: 'Configuratie ontbreekt',
  insufficient_baseload: 'Basislast ontbreekt', forecast_unavailable: 'Geen verwachting',
  forecast_incomplete: 'Verwachting onvolledig', sun_times_unavailable: 'Zontijden ontbreken', no_daylight_window: 'Geen starttijd meer'
};

/** Toont per apparaat een startmoment op iedere voorspelde dag; input: container, profielen en dagadviezen; output: void. */
export function renderDailyAdvice(container, profiles, daily) {
  container.replaceChildren();
  for (const profile of profiles) {
    const card = document.createElement('article'); card.className = 'appliance';
    const title = document.createElement('h3'); title.textContent = profile.name;
    const duration = document.createElement('p'); duration.textContent = `Cyclus: ${profile.duration_minutes} min`;
    const list = document.createElement('dl'); list.className = 'daily-starts';
    for (const day of daily.days) {
      const advice = day.appliances.find((item) => item.id === profile.id);
      const row = document.createElement('div'); row.className = 'daily-start';
      const date = document.createElement('dt'); date.textContent = dayFormat.format(new Date(`${day.date}T12:00:00Z`));
      const start = document.createElement('dd');
      if (advice?.status === 'ok' && advice.earliest_start) {
        start.textContent = timeFormat.format(new Date(advice.earliest_start));
        if (advice.can_start_now) start.textContent = `Nu · ${start.textContent}`;
        start.className = 'start-time';
        start.title = `Eigen zon: ${advice.earliest.solar_share_percent}%`;
      } else {
        start.textContent = advice?.status === 'ok' ? 'Te weinig zon' : statuses[advice?.status] ?? 'Geen advies';
        start.className = 'start-unavailable';
      }
      row.append(date, start); list.append(row);
    }
    card.append(title, duration, list); container.append(card);
  }
}
