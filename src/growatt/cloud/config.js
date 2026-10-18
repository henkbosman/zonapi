export const GROWATT_CLOUD_POLL_SECONDS = 300;

/** Leest de optionele Growatt-cloudinstellingen; input: applicatie-instellingen; output: gevalideerde bronkeuze en vaste vijfminutenplanning of fout. */
export function growattCloudConfig(settings) {
  const source = settings.growatt?.production_source ?? 'shinelink';
  if (!['shinelink', 'cloud', 'auto'].includes(source)) throw new Error('growatt.production_source moet shinelink, cloud of auto zijn');
  const supplied = settings.growatt?.cloud ?? {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('growatt.cloud moet een object zijn');
  const config = { base_url: 'https://openapi.growatt.com', token_env: 'GROWATT_API_TOKEN', token: '', plant_id: '',
    device_type: 'min', poll_seconds: GROWATT_CLOUD_POLL_SECONDS, request_pause_ms: 1100, daylight_only: false, timezone: settings.timezone ?? 'Europe/Amsterdam', ...supplied };
  let url;
  try { url = new URL(config.base_url); } catch { throw new Error('growatt.cloud.base_url moet een HTTPS-serveradres zijn'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('growatt.cloud.base_url moet een HTTPS-serveradres zonder pad of inloggegevens zijn');
  config.base_url = url.origin;
  if (typeof config.token !== 'string' || typeof config.token_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.token_env)) throw new Error('growatt.cloud.token/token_env ongeldig');
  if (!['string', 'number'].includes(typeof config.plant_id) || !/^[A-Za-z0-9_-]{0,64}$/.test(String(config.plant_id))) throw new Error('growatt.cloud.plant_id ongeldig');
  config.plant_id = String(config.plant_id);
  if (!['min', 'inv'].includes(config.device_type)) throw new Error('growatt.cloud.device_type moet min of inv zijn');
  if (!Number.isInteger(config.poll_seconds) || config.poll_seconds < 300 || config.poll_seconds > 86400) throw new Error('growatt.cloud.poll_seconds moet 300..86400 zijn');
  if (!Number.isInteger(config.request_pause_ms) || config.request_pause_ms < 1000 || config.request_pause_ms > 10000) throw new Error('growatt.cloud.request_pause_ms moet 1000..10000 zijn');
  if (typeof config.daylight_only !== 'boolean') throw new Error('growatt.cloud.daylight_only moet true of false zijn');
  try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }).format(); } catch { throw new Error('growatt.cloud.timezone ongeldig'); }
  // Ook een bestaand interval van 900 seconden gebruikt automatisch de vaste vijfminutenplanning.
  return { source, ...config, poll_seconds: GROWATT_CLOUD_POLL_SECONDS, poll_schedule: 'five_minutes' };
}

/** Leest uitsluitend het ingestelde Growatt-token; input: cloudconfig en optionele omgevingsvariabelen; output: getrimd token of lege string. */
export function growattCloudToken(config, environment = process.env) {
  return (environment[config.token_env] || config.token).trim();
}
