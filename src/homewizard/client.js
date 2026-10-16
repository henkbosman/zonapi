import { readFileSync } from 'node:fs';
import https from 'node:https';

/** Beperkt het apparaatadres tot een LAN-host zonder URL-pad; input: hostname/IP; output: host of fout. */
export function checkHost(host) {
  if (typeof host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('HomeWizard-host moet een lokaal IP of DNS-naam zijn');
  return host;
}

/** Vergelijkt het bekende HomeWizard-certificaatpad zonder ongeldige SNI-hostnaam; input: verwacht type/serial en TLS-certificaat; output: undefined of Error. */
export function verifyHomeWizardIdentity(expected, certificate) {
  const cn = certificate.subject?.CN;
  const dns = (certificate.subjectaltname ?? '').split(/,\s*/).filter((entry) => entry.startsWith('DNS:')).map((entry) => entry.slice(4));
  return cn === expected || dns.includes(expected) ? undefined : new Error('HomeWizard-certificaat komt niet overeen met producttype en serienummer');
}

/** Leest lokaal HomeWizard v2 via HTTPS en Bearer-token; input: apparaatconfig en optionele https-module; output: Promise<JSON>. */
export async function requestV2(config, transport = https) {
  const token = process.env[config.token_env];
  if (!token) throw new Error(`Ontbrekende omgevingvariabele: ${config.token_env}`);
  if (config.tls_insecure_skip_verify !== true && (!config.ca_file || !config.tls_servername)) throw new Error('Stel voor v2 ca_file en tls_servername in, of kies expliciet tls_insecure_skip_verify');
  return new Promise((resolve, reject) => {
    const options = {
      hostname: checkHost(config.host), path: '/api/measurement', method: 'GET', timeout: 5000,
      headers: { Authorization: `Bearer ${token}`, 'X-Api-Version': '2' },
      rejectUnauthorized: config.tls_insecure_skip_verify !== true
    };
    if (config.tls_insecure_skip_verify !== true) {
      options.ca = readFileSync(config.ca_file);
      options.checkServerIdentity = (_host, certificate) => verifyHomeWizardIdentity(config.tls_servername, certificate);
    }
    const request = transport.request(options, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part) => { text += part; if (text.length > 1000000) request.destroy(new Error('HomeWizard-antwoord te groot')); });
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new Error(`HomeWizard v2 HTTP ${response.statusCode}`));
        else { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }
      });
    });
    request.on('timeout', () => request.destroy(new Error('HomeWizard time-out')));
    request.on('error', reject);
    request.end();
  });
}

/** Leest HomeWizard v1 rechtstreeks via LAN-HTTP; input: apparaatconfig en fetch-functie; output: Promise<JSON>. */
export async function requestV1(config, fetcher = fetch) {
  const response = await fetcher(meterRequestUrl(config), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HomeWizard v1 HTTP ${response.status}`);
  return response.json();
}

/** Geeft de lokale meet-URL zonder autorisatiegegevens; input: apparaatconfiguratie; output: URL-string of fout. */
export function meterRequestUrl(config) {
  return config.api === 'v2' ? `https://${checkHost(config.host)}/api/measurement` : `http://${checkHost(config.host)}/api/v1/data`;
}

/** Zet v1/v2-velden om naar netto vermogen en tellers; input: apparaat-id, API-versie, JSON, tijd-ms; output: meetobject of fout. */
export function normalizeMeter(device, api, body, now) {
  const isV1 = api === 'v1';
  const value = isV1 ? body.active_power_w : body.power_w;
  if (!Number.isFinite(value)) throw new Error(`Geen netto vermogen voor ${device}`);
  const importKwh = isV1 ? body.total_power_import_kwh : body.energy_import_kwh;
  const exportKwh = isV1 ? body.total_power_export_kwh : body.energy_export_kwh;
  return { device, measured_ms: now, received_ms: now, net_power_w: value, import_kwh: Number.isFinite(importKwh) ? importKwh : null, export_kwh: Number.isFinite(exportKwh) ? exportKwh : null };
}

/** Leest één HomeWizard-apparaat volgens de geconfigureerde lokale API; input: id en apparaatconfig; output: Promise<meetobject>. */
export async function fetchMeter(device, config) {
  if (!config.host) throw new Error(`${device}: host niet ingesteld`);
  const api = config.api;
  if (!['v1', 'v2'].includes(api)) throw new Error(`${device}: ongeldige API-versie`);
  const body = api === 'v1' ? await requestV1(config) : await requestV2(config);
  return normalizeMeter(device, api, body, Date.now());
}
