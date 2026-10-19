const dayFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
const statuses = {
  stale: 'Verwachting verouderd', configuration_incomplete: 'Configuratie ontbreekt',
  insufficient_baseload: 'Basislast ontbreekt', forecast_unavailable: 'Geen verwachting',
  forecast_incomplete: 'Verwachting onvolledig', sun_times_unavailable: 'Zontijden ontbreken', no_daylight_window: 'Geen starttijd meer',
  already_active: 'Actieve cyclus meegerekend'
};

/** Toont het gemeten draaien van een apparaat; input: apparaatkaart en actuele socketstatus; output: void. */
function renderActivity(card, activity) {
  if (!activity?.configured) return;
  const state = document.createElement('p');
  state.className = `appliance-activity activity-${activity.state}`;
  state.setAttribute('role', 'status');
  const power = Number.isFinite(activity.power_w) ? ` · ${Math.round(activity.power_w)} W` : '';
  const names = { running: 'Actief', starting: 'Start wordt herkend', idle: 'Niet actief', waiting: 'Wachten op socketmeting', unavailable: 'Socket niet bereikbaar' };
  state.textContent = `${names[activity.state] ?? 'Status onbekend'}${power}`;
  if (activity.error) state.title = activity.error;
  card.append(state);
  if (activity.running && activity.started_at) {
    const started = document.createElement('p'); started.className = 'activity-since';
    started.textContent = `Actief sinds ${timeFormat.format(new Date(activity.started_at))}`;
    started.title = `Start herkend vanaf ${new Date(activity.started_at).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}`;
    card.append(started);
  }
}

/** Geeft een bruikbaar alternatief als een hele cyclus op zon niet haalbaar is; input: dagadvies; output: beste gedeeltelijk gedekte cyclus of null. */
function solarAlternative(advice) {
  if (advice?.status !== 'ok' || !advice.best_start || !advice.best) return null;
  const share = advice.best.solar_share ?? advice.best.solar_share_percent / 100;
  return Number.isFinite(share) && share > 0 && share < 1 ? advice.best : null;
}

/** Voegt het beste zonmoment met de verwachte dekking toe; input: tijdvak, beste cyclus en eventueel al getoonde start; output: void. */
function renderSolarAlternative(element, best, displayedStart) {
  const note = document.createElement('span'); note.className = 'start-solar-note';
  const time = best.start === displayedStart ? '' : `: ${timeFormat.format(new Date(best.start))}`;
  const percent = best.solar_share_percent === 0 ? '<0,1' : best.solar_share_percent.toLocaleString('nl-NL');
  note.textContent = `Meeste zon${time} · ${percent}%`;
  element.append(note);
  const detail = `Verwachte zonne-energie over de volledige cyclus: ${best.solar_wh} van ${best.energy_wh} Wh. Aanvulling uit het net nodig.`;
  element.title = element.title ? `${element.title}\n${detail}` : detail;
}

/** Toont per apparaat een startmoment op iedere voorspelde dag; input: container, profielen en dagadviezen; output: void. */
export function renderDailyAdvice(container, profiles, daily) {
  container.replaceChildren();
  for (const profile of profiles) {
    const card = document.createElement('article'); card.className = 'appliance';
    const title = document.createElement('h3'); title.textContent = profile.name;
    const programs = profile.programs?.length ? profile.programs : [{ id: 'standaard', name: 'Standaard', duration_minutes: profile.duration_minutes }];
    const multiple = programs.length > 1;
    const duration = document.createElement('p'); duration.textContent = multiple ? `${programs.length} programma’s` : `Programma: ${programs[0].name} · Cyclus: ${programs[0].duration_minutes} min`;
    card.append(title, duration);
    if (Number.isFinite(profile.minimum_solar_share_percent)) {
      const minimum = document.createElement('p'); minimum.className = 'appliance-minimum';
      minimum.textContent = `Minimale zonnedekking: ${profile.minimum_solar_share_percent.toLocaleString('nl-NL', { maximumFractionDigits: 2 })}%`;
      minimum.title = profile.minimum_solar_share_source === 'general' ? 'Gebruikt de algemene minimale zonnedekking' : 'Gebruikt de minimale zonnedekking van dit apparaat';
      card.append(minimum);
    }
    renderActivity(card, profile.activity);
    const active = (daily.active_appliances ?? []).filter((item) => item.id !== profile.id);
    if (active.length) {
      const accounted = document.createElement('p'); accounted.className = 'active-appliances-note';
      accounted.textContent = `Rekening gehouden met: ${active.map((item) => `${item.name}${item.fresh ? '' : ' (laatste status actief)'}`).join(', ')}`;
      accounted.title = active.map((item) => `${item.name}: nog circa ${item.remaining_minutes} min${item.overrun ? '; programma duurt langer dan verwacht' : ''}`).join('\n');
      card.append(accounted);
    }
    for (const program of programs) {
      const section = multiple ? document.createElement('section') : card;
      if (multiple) {
        section.className = 'appliance-program';
        const heading = document.createElement('h4'); heading.textContent = program.name;
        const length = document.createElement('p'); length.textContent = `Cyclus: ${program.duration_minutes} min`;
        section.append(heading, length);
      }
      const list = document.createElement('dl'); list.className = 'daily-starts';
      for (const [index, day] of daily.days.entries()) {
        const appliance = day.appliances.find((item) => item.id === profile.id);
        const advice = profile.programs?.length ? appliance?.programs?.find((item) => item.program_id === program.id || item.id === program.id)
          ?? (multiple ? null : appliance) : appliance;
        const row = document.createElement('div'); row.className = 'daily-start';
        const date = document.createElement('dt'); date.textContent = dayFormat.format(new Date(`${day.date}T12:00:00Z`));
        const start = document.createElement('dd');
        const alternative = solarAlternative(advice);
        if (index === 0 && profile.activity?.running) {
          start.textContent = multiple ? 'Apparaat bezig' : 'Bezig'; start.className = 'start-time';
        } else if (advice?.status === 'ok' && advice.earliest_start) {
          start.textContent = timeFormat.format(new Date(advice.earliest_start));
          if (advice.can_start_now) start.textContent = `Nu · ${start.textContent}`;
          start.className = 'start-time';
          start.title = `Eigen zon: ${advice.earliest.solar_share_percent}%`;
          if (alternative) renderSolarAlternative(start, alternative, advice.earliest_start);
        } else if (alternative) {
          start.textContent = timeFormat.format(new Date(advice.best_start));
          start.className = 'start-time start-alternative';
          renderSolarAlternative(start, alternative, advice.best_start);
        } else {
          start.textContent = advice?.status === 'ok' ? 'Te weinig zon' : statuses[advice?.status] ?? 'Geen advies';
          start.className = 'start-unavailable';
        }
        row.append(date, start); list.append(row);
      }
      section.append(list);
      if (multiple) card.append(section);
    }
    container.append(card);
  }
}
