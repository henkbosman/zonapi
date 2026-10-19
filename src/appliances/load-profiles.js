import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { socketConfig } from './socket-config.js';
import { appliancePrograms, programId } from './programs.js';

/** Controleert een verbruiksreeks zonder ongeldige JSON-typen te derefereren; input: stappen, veldpad en foutlijst; output: void. */
function validateSteps(steps, path, errors) {
  if (!Array.isArray(steps) || !steps.length) { errors.push(`${path} ontbreekt of is leeg`); return; }
  for (const [index, step] of steps.entries()) {
    if (!Number.isInteger(step?.duration_minutes) || step.duration_minutes < 1) errors.push(`${path}[${index}].duration_minutes ongeldig`);
    if (!Number.isFinite(step?.power_w) || step.power_w < 0 || step.power_w > 10000) errors.push(`${path}[${index}].power_w ongeldig`);
  }
  if (steps.every((step) => step?.power_w === 0)) errors.push(`${path} heeft geen energieverbruik`);
}

/** Controleert één apparaatprofiel; input: JSON-object; output: foutlijst. */
export function validateProfile(profile) {
  const errors = [];
  if (!/^[a-z0-9_-]+$/.test(profile?.id ?? '')) errors.push('id moet letters/cijfers/-/_ bevatten');
  if (typeof profile?.name !== 'string' || !profile.name.trim()) errors.push('name ontbreekt');
  if (profile?.programs === undefined) validateSteps(profile?.steps, 'steps', errors);
  else if (!Array.isArray(profile.programs) || !profile.programs.length) errors.push('programs moet een niet-lege lijst zijn');
  else {
    const ids = new Set(), names = new Set();
    for (const [index, program] of profile.programs.entries()) {
      const path = `programs[${index}]`, name = typeof program?.name === 'string' ? program.name.trim() : '';
      if (!name) errors.push(`${path}.name ontbreekt`);
      else if (names.has(name.toLocaleLowerCase('nl-NL'))) errors.push(`${path}.name is dubbel`);
      names.add(name.toLocaleLowerCase('nl-NL'));
      const id = program?.id ?? programId(name, index);
      if (typeof id !== 'string' || !/^[a-z0-9_-]+$/.test(id)) errors.push(`${path}.id ongeldig`);
      else if (ids.has(id)) errors.push(`${path}.id is dubbel`);
      ids.add(id);
      validateSteps(program?.steps, `${path}.steps`, errors);
    }
  }
  if (profile?.min_solar_share != null && (!Number.isFinite(profile.min_solar_share) || profile.min_solar_share < 0 || profile.min_solar_share > 1)) errors.push('min_solar_share moet 0..1 of null zijn');
  if (profile?.reserve_w !== undefined && (!Number.isFinite(profile.reserve_w) || profile.reserve_w < 0)) errors.push('reserve_w moet >=0 zijn');
  try { socketConfig(profile); } catch (error) { errors.push(error.message); }
  return errors;
}

/** Leest elk JSON-bestand uit de apparatenmap; input: map-pad; output: {profiles,errors}. */
export function loadProfiles(directory) {
  const profiles = new Map();
  const errors = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const profile = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      const violations = validateProfile(profile);
      if (profiles.has(profile?.id)) violations.push(`dubbel apparaat-id ${profile.id}`);
      if (violations.length) errors.push({ file, errors: violations });
      else {
        const programs = appliancePrograms(profile);
        profiles.set(profile.id, { ...profile, programs, duration_minutes: Math.max(...programs.map((program) => program.duration_minutes)) });
      }
    } catch (error) { errors.push({ file, errors: [error.message] }); }
  }
  return { profiles, errors };
}
