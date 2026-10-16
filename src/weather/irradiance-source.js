import { fetchOpenMeteo, forecastUrl } from './open-meteo-client.js';

/** Selecteert een uitwisselbare weerbron; input: broncode; output: async bronfunctie of fout. */
export function getIrradianceSource(name) {
  const sources = { 'open-meteo': fetchOpenMeteo };
  if (!sources[name]) throw new Error(`Onbekende weerbron: ${name}`);
  return sources[name];
}

/** Bepaalt het te verzenden weeradres zonder netwerkverkeer; input: bron, locatie en aantal dagen; output: URL-string of null. */
export function irradianceRequestUrl(name, { latitude, longitude, days }) {
  const urls = { 'open-meteo': forecastUrl };
  return urls[name] ? urls[name](latitude, longitude, days).toString() : null;
}
