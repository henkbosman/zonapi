import { fetchOpenMeteo } from './open-meteo-client.js';

/** Selecteert een uitwisselbare weerbron; input: broncode; output: async bronfunctie of fout. */
export function getIrradianceSource(name) {
  const sources = { 'open-meteo': fetchOpenMeteo };
  if (!sources[name]) throw new Error(`Onbekende weerbron: ${name}`);
  return sources[name];
}
