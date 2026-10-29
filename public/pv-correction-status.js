const time = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });

/** Geeft een concrete reden waarom een correctie nog niet is opgeslagen; input: laatste leerpoging; output: korte Nederlandse tekst. */
export function correctionAttemptText(attempt) {
  if (!attempt) return 'wachten op de eerste meetronde';
  if (attempt.status === 'waiting_for_day_end') return 'wachten tot de meetdag voorbij is';
  if (['checking_clear_sky', 'waiting_for_clear_sky_window'].includes(attempt.status)) return 'bewolkingscontrole';
  if (attempt.status === 'clear_sky_data_missing') return 'bewolkingsgegevens ontbreken of zijn onbekend';
  if (attempt.status === 'waiting_for_clear_sky_data') return 'bewolkingsgegevens nog niet beschikbaar';
  if (attempt.status === 'clouds_present') return `geen nieuwe correctie: bewolking boven ${attempt.clear_sky?.max_allowed_cloud_cover_percent ?? 0}%`;
  if (attempt.status === 'waiting_for_samples') return `wachten op meetpunten (${attempt.received_samples ?? 0}/3)`;
  if (attempt.status === 'incomplete') return Number.isFinite(attempt.received_inverters)
    ? `wachten op omvormers (${attempt.received_inverters}/${attempt.expected_inverters})` : 'meetronde onvolledig';
  const labels = { disabled: 'uitgeschakeld', configuration_incomplete: 'paneelconfiguratie of locatie onvolledig', stale: 'Growatt-metingen te oud',
    time_skew: 'meettijden liggen te ver uiteen', low_forecast: 'te weinig voorspelde opwek', forecast_unavailable: 'weersvoorspelling ontbreekt',
    forecast_stale: 'weersvoorspelling te oud', older_measurement: 'meting is ouder dan de opgeslagen correctie', error: 'fout bij berekenen van de correctie',
    updated: 'opgeslagen', unchanged: 'actueel', invalid_block: 'ongeldig correctieblok' };
  return labels[attempt.status] ?? attempt.status;
}

/** Toont een factor of een verklaarde wachtstatus in de bestaande grafieklegenda; input: element en correctie-API; output: void. */
export function renderPvCorrection(element, correction) {
  const sampling = Number.isFinite(correction?.latest?.sampling?.used_samples) ? correction.latest.sampling : null, attempt = correction?.last_attempt;
  const active = correction?.status === 'active' && correction.latest;
  element.textContent = active
    ? `Correctie ${correction.latest.correction_percent > 0 ? '+' : ''}${correction.latest.correction_percent.toLocaleString('nl-NL')}%${correction.latest.start ? ` · Blok ${time.format(new Date(correction.latest.start))}–${time.format(new Date(correction.latest.end))}` : ''} · Blokken vandaag ${correction.learned_blocks_today ?? correction.learned_quarters}/${correction.total_blocks_in_day ?? 96}${sampling ? ` · ${sampling.used_samples}/3 metingen${sampling.ignored_times.length ? ' · 1 uitschieter genegeerd' : ''}` : ''}`
    : `Correctie: ${correction?.status === 'disabled' ? 'uitgeschakeld' : correctionAttemptText(attempt)}`;
  if (active && ['waiting_for_day_end', 'waiting_for_clear_sky_window', 'clear_sky_data_missing', 'waiting_for_clear_sky_data', 'clouds_present'].includes(attempt?.status)) {
    element.textContent += ` · ${correctionAttemptText(attempt)}`;
  }
  const details = [];
  if (correction?.latest?.start) {
    details.push(`Gemeten blok: ${correction.latest.date} ${time.format(new Date(correction.latest.start))}–${time.format(new Date(correction.latest.end))}`);
    details.push('Vandaag en toekomstige dagen gebruiken per klokkwartier de eigen laatst gemeten factor, op de weerverwachting van die dag.');
  }
  if (sampling) details.push(...sampling.samples.map((sample) => `${time.format(new Date(sample.time))}: ${Math.round(sample.power_w)} W${sample.used ? '' : ' (genegeerd)'}`));
  if (sampling?.clear_sky) {
    details.push(`Bewolking binnen ${sampling.clear_sky.max_allowed_cloud_cover_percent ?? 0}%: ${time.format(new Date(sampling.clear_sky.window_start))}–${time.format(new Date(sampling.clear_sky.window_end))}`);
    if (sampling.clear_sky.uses_forecast) details.push('De bewolkingsverwachting voor de komende uren is direct gebruikt.');
  }
  if (attempt) {
    details.push(`Laatste poging: ${time.format(new Date(attempt.attempted_at))} · ${correctionAttemptText(attempt)}`);
    if (attempt.target_time) details.push(`Kwartier: ${time.format(new Date(attempt.target_time))}`);
    if (attempt.status === 'waiting_for_day_end' && attempt.ready_at) details.push(`Berekening na afloop van de meetdag, vanaf ${new Date(attempt.ready_at).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}`);
    if (attempt.moments) details.push(...attempt.moments.map((moment) => `${time.format(new Date(moment.time))}: ${moment.received_inverters}/${moment.expected_inverters} omvormers${moment.complete ? '' : ' · onvolledig'}`));
    if (attempt.diagnostics?.rejected_timing) details.push(`${attempt.diagnostics.rejected_timing} metingen buiten de ingestelde tijdsmarge`);
    if (attempt.diagnostics?.rejected_skew) details.push(`${attempt.diagnostics.rejected_skew} meetmomenten met te grote onderlinge tijdsverschillen`);
    if (attempt.message) details.push(attempt.message);
    if (attempt.clear_sky) {
      const sky = attempt.clear_sky;
      details.push(`Maximaal ${sky.max_allowed_cloud_cover_percent ?? 0}% bewolking van ${time.format(new Date(sky.window_start))} tot ${time.format(new Date(sky.window_end))}`);
      details.push(sky.checked_from === sky.checked_until ? `Bewolkingspunt in dit kwartier: ${time.format(new Date(sky.checked_from))}`
        : `Gecontroleerde bronpunten: ${time.format(new Date(sky.checked_from))}–${time.format(new Date(sky.checked_until))}`);
      if (Number.isFinite(sky.max_cloud_cover_percent)) details.push(`Hoogste bewolking: ${sky.max_cloud_cover_percent}%`);
    }
  }
  element.title = details.join('\n');
}
