/** Verwijdert geheimen uit API-resultaten en fouten; input: JSON-waarde en actueel token; output: geschoonde JSON-waarde zonder token, cookies of wachtwoorden. */
export function redactCloud(value, token = '') {
  if (typeof value === 'string') {
    for (const secret of new Set([token, token ? encodeURIComponent(token) : ''])) if (secret) value = value.split(secret).join('[verborgen]');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactCloud(item, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|password|authorization|cookie|secret/i.test(key) ? '[verborgen]' : redactCloud(item, token)]));
  return value;
}
