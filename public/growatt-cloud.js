const fullTime = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Formatteert een webbrontijd; input: ISO-tijd of null; output: lokale datum/tijd of streepje. */
function time(value) { return value ? fullTime.format(new Date(value)) : '—'; }

/** Vat de driepuntscorrectie samen; input: correctieresultaat; output: kwartier, aantal gebruikte metingen of wachtreden. */
function correctionText(result) {
  if (!result) return '—';
  if (result.status === 'waiting_for_day_end') return `Wachten tot de meetdag voorbij is${result.ready_at ? ` · vanaf ${time(result.ready_at)}` : ''}`;
  if (['checking_clear_sky', 'waiting_for_clear_sky_window'].includes(result.status)) return 'Bewolkingscontrole';
  if (result.status === 'waiting_for_samples') return `${result.received_samples}/3 ontvangen · wachten op ${result.missing_times.map(time).join(', ')}`;
  if (result.status === 'clouds_present') return `Geen nieuwe correctie: bewolking boven ${result.clear_sky?.max_allowed_cloud_cover_percent ?? 0}%`;
  if (['updated', 'unchanged'].includes(result.status) && result.sampling) return `${result.time} · ${result.sampling.used_samples}/3 metingen${result.sampling.ignored_times.length ? ' · 1 uitschieter genegeerd' : ''}`;
  const labels = { disabled: 'Uitgeschakeld', incomplete: 'Meetronde onvolledig', stale: 'Metingen verouderd', low_forecast: 'Te weinig voorspelde opwek', forecast_unavailable: 'Voorspelling ontbreekt', forecast_stale: 'Voorspelling verouderd',
    clear_sky_data_missing: 'Bewolkingsgegevens ontbreken of zijn onbekend', waiting_for_clear_sky_data: 'Bewolkingsgegevens nog niet beschikbaar' };
  return labels[result.status] ?? result.status;
}

/** Vult het compacte webbronoverzicht; input: niet-geheime cloudstatus; output: void. */
export function renderGrowattCloud(cloud) {
  const labels = { disabled: 'Uitgeschakeld', configuration_incomplete: 'Configuratie ontbreekt', waiting: 'Wachten', ok: 'Actief', partial: 'Gedeeltelijk', error: 'Fout' };
  const values = { 'cloud-state': cloud.fetching ? 'Bezig' : labels[cloud.state] ?? cloud.state, 'cloud-token': cloud.configured ? 'Ingesteld' : 'Ontbreekt',
    'cloud-server': cloud.base_url ?? '—', 'cloud-plant': cloud.plant_id ?? '—', 'cloud-interval': cloud.poll_schedule === 'five_minutes' ? ':00 · :05 · :10 · … · :55' : cloud.poll_seconds ? `${cloud.poll_seconds / 60} min` : '—',
    'cloud-attempt': time(cloud.last_attempt), 'cloud-success': time(cloud.last_success), 'cloud-next': time(cloud.next_fetch),
    'cloud-scheduled': time(cloud.last_scheduled), 'cloud-delay': Number.isFinite(cloud.schedule_delay_ms) ? `${cloud.schedule_delay_ms.toLocaleString('nl-NL')} ms` : '—',
    'cloud-correction': correctionText(cloud.forecast_correction),
    'cloud-http': cloud.last_request?.http_status ?? '—', 'cloud-error': cloud.last_error ?? '—' };
  for (const [id, value] of Object.entries(values)) { const element = document.getElementById(id); if (element) element.textContent = value; }
  const correction = document.getElementById('cloud-correction');
  if (correction) correction.title = cloud.forecast_correction?.sampling?.samples.map((sample) => `${time(sample.time)} · ${Math.round(sample.power_w)} W${sample.used ? '' : ' · genegeerd'}`).join('\n') ?? '';
  if (correction && cloud.forecast_correction?.clear_sky) {
    const sky = cloud.forecast_correction.clear_sky;
    correction.title += `${correction.title ? '\n' : ''}Maximaal ${sky.max_allowed_cloud_cover_percent ?? 0}% bewolking: ${time(sky.window_start)}–${time(sky.window_end)}; bronpunt ${time(sky.checked_from)}`;
    if (sky.uses_forecast) correction.title += '\nDe bewolkingsverwachting voor de komende uren is direct gebruikt.';
  }
  document.getElementById('cloud-poll').disabled = !cloud.enabled || !cloud.configured || cloud.fetching;
  const list = document.getElementById('cloud-plants');
  list.replaceChildren();
  if ((cloud.plants ?? []).length > 1) for (const plant of cloud.plants) {
    const item = document.createElement('span');
    item.textContent = `${plant.name} · ${plant.plant_id}`;
    list.append(item);
  }
}

/** Verbindt de handmatige cloudophaling aan de Growatt-pagina; input: vernieuwfunctie; output: void, interval en terugval blijven op de server gelden. */
export function setupGrowattCloud(refresh) {
  const button = document.getElementById('cloud-poll');
  let busy = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      const response = await fetch('/intern/api/v1/growatt/cloud/poll', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(120000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      await refresh();
      if (!result.attempted) {
        const reasons = { disabled: 'Web-API uitgeschakeld', configuration: 'API-token ontbreekt', busy: 'Verzoek loopt al', daylight: 'Buiten zonuren', sun_times: 'Zontijden ontbreken', local_fresh: 'ShineLink-metingen actueel', stopped: 'Dienst stopt' };
        document.getElementById('connection').textContent = result.reason === 'interval' ? `Volgend verzoek: ${time(result.status?.next_fetch)}` : reasons[result.reason] ?? result.reason;
      }
    } catch (error) { document.getElementById('connection').textContent = `Fout: ${error.message}`; }
    finally { busy = false; }
  });
}

/** Toont één geschoond Growatt-webantwoord in het bestaande detailpaneel; input: verzoek-id; output: Promise<void> met JSON, HTTP-metadata of zichtbare fout. */
export async function showGrowattCloudCall(id) {
  try {
    const response = await fetch(`/intern/api/v1/growatt/cloud/calls/${id}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const row = await response.json();
    if (!response.ok) throw new Error(row.error ?? `HTTP ${response.status}`);
    document.getElementById('detail-title').textContent = `Webverzoek #${row.id}`;
    const meta = document.getElementById('detail-meta');
    meta.replaceChildren();
    for (const value of [time(row.attempted_at), row.method, row.request_url, row.http_status === null ? 'HTTP —' : `HTTP ${row.http_status}`, row.status, row.device_serial ?? '—', `${row.duration_ms} ms`, row.detail ?? '']) {
      if (!value) continue;
      const item = document.createElement('span');
      item.textContent = value;
      meta.append(item);
    }
    for (const field of ['detail-announcement', 'detail-rf-configuration', 'detail-measurement']) document.getElementById(field).replaceChildren();
    let text = row.response_json ?? '—';
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Afgekapt antwoord blijft als oorspronkelijke tekst leesbaar. */ }
    document.getElementById('detail-hex').textContent = text;
    const detail = document.getElementById('frame-detail');
    detail.hidden = false;
    detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { document.getElementById('connection').textContent = `Fout: ${error.message}`; }
}
