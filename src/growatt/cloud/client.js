import { setTimeout as delay } from 'node:timers/promises';
import { normalizeGrowattCloud } from './normalize.js';
import { redactCloud } from './redact.js';

/** Bepaalt Retry-After uit een Growatt-response; input: headertekst en huidige ms; output: wachttijd in ms of nul. */
function retryAfter(value, now) {
  if (!value) return 0;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(86400000, Math.max(0, ms)) : 0;
}

/** Maakt de uitsluitend lezende Growatt-webadapter; input: cloudconfig, token en optionele fetch/klok/logfunctie; output: {plants,devices,read}, alle verzoeken gebruiken het token alleen als header. */
export function createGrowattCloudClient(config, token, { fetcher = fetch, clock = () => Date.now(), onCall = () => {}, pause = delay } = {}) {
  let lastRequest = -Infinity;

  /** Voert één afgebakend leesverzoek uit en bewaart diagnose; input: pad, query/body, signaal en optionele omzetter; output: API-data of fout met HTTP-status en wachttijd. */
  async function request(path, { params = {}, body, signal, transform = (value) => value } = {}) {
    const wait = config.request_pause_ms - (clock() - lastRequest);
    if (wait > 0) await pause(wait, undefined, { signal });
    signal?.throwIfAborted();
    const url = new URL(path, config.base_url);
    url.search = new URLSearchParams(params).toString();
    const started = clock(), method = body ? 'POST' : 'GET';
    lastRequest = started;
    let response, json, failure, result;
    try {
      response = await fetcher(url, { method, headers: { token, Accept: 'application/json', 'User-Agent': 'ZonAPI/0.1', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(body ? { body: new URLSearchParams(body).toString() } : {}), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
      const text = await response.text();
      if (text.length > 2000000) throw new Error('Growatt: antwoord te groot');
      try { json = JSON.parse(text); } catch { throw new Error(`Growatt HTTP ${response.status}: geen JSON-antwoord`); }
      const code = json.error_code ?? json.code;
      if (!response.ok || ![0, '0'].includes(code)) {
        const message = redactCloud(String(json.error_msg || json.message || json.msg || 'API-fout'), token).slice(0, 400);
        throw Object.assign(new Error(`Growatt HTTP ${response.status}${code === undefined ? '' : ` · code ${code}`}: ${message}`), { api_code: code ?? null });
      }
      result = transform(json.data, started);
    } catch (error) {
      failure = Object.assign(new Error(redactCloud(String(error.message ?? error), token)), { http_status: response?.status ?? null, api_code: error.api_code ?? null,
        retry_after_ms: Math.max(retryAfter(response?.headers.get('retry-after'), clock()), [102, 501].includes(Number(error.api_code)) ? 300000 : 0) });
    }
    onCall({ attempted_ms: started, method, request_url: url.toString(), device_serial: body?.deviceSn ?? null, http_status: response?.status ?? null,
      duration_ms: Math.max(0, clock() - started), status: failure ? 'error' : 'ok', detail: failure?.message ?? null,
      response_json: json === undefined ? null : JSON.stringify(redactCloud(json, token)).slice(0, 32768) });
    if (failure) throw failure;
    return result;
  }

  /** Leest alle pagina's van één lijst; input: API-pad, lijstveld, parameters en signaal; output: bronobjecten of fout bij afgekapt resultaat. */
  async function pages(path, field, params, signal) {
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const data = await request(path, { params: { ...params, page: String(page), perpage: '100' }, signal });
      const items = data?.[field];
      if (!Array.isArray(items)) throw new Error(`Growatt: ${field}-lijst ontbreekt`);
      rows.push(...items);
      const count = Number(data.count);
      if (items.length < 100 || (Number.isFinite(count) && count >= 0 && rows.length >= count)) return rows;
    }
    throw new Error('Growatt: meer dan 1000 resultaten; stel plant_id of omvormerserienummers in');
  }

  /** Leest de beschikbare installaties; input: optioneel afbreeksignaal; output: {plant_id,name}[] zonder accountgegevens. */
  async function plants(signal) {
    const rows = await pages('/v1/plant/list', 'plants', {}, signal);
    return rows.map((item) => ({ plant_id: String(item.plant_id), name: String(item.name ?? item.plant_id) }));
  }

  /** Herkent ondersteunde omvormers van één installatie; input: plant-id en optioneel afbreeksignaal; output: serial/type-objecten, geen meters of loggers. */
  async function devices(plantId, signal) {
    const rows = await pages('/v1/device/list', 'devices', { plant_id: plantId }, signal);
    return rows.filter((item) => [1, 7].includes(Number(item.type))).map((item) => ({ serial: String(item.device_sn).toUpperCase(), device_type: Number(item.type) === 7 ? 'min' : 'inv' }));
  }

  /** Leest één recente omvormermeting via v4 zonder instellingen te wijzigen; input: serial/type en afbreeksignaal; output: genormaliseerde meting. */
  async function read(device, signal) {
    return request('/v4/new-api/queryLastData', { body: { deviceType: device.device_type, deviceSn: device.serial }, signal,
      transform: (data, requestedMs) => ({ ...normalizeGrowattCloud(data, device, clock(), config.timezone), requested_ms: requestedMs }) });
  }

  return { plants, devices, read };
}
