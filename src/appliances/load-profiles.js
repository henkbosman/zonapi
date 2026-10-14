import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Controleert één apparaatprofiel; input: JSON-object; output: foutlijst. */
export function validateProfile(profile) {
  const errors = [];
  if (!/^[a-z0-9_-]+$/.test(profile?.id ?? '')) errors.push('id moet letters/cijfers/-/_ bevatten');
  if (typeof profile?.name !== 'string' || !profile.name.trim()) errors.push('name ontbreekt');
  if (!Array.isArray(profile?.steps) || !profile.steps.length) errors.push('steps ontbreekt');
  for (const [index, step] of (profile?.steps ?? []).entries()) {
    if (!Number.isInteger(step.duration_minutes) || step.duration_minutes < 1) errors.push(`steps[${index}].duration_minutes ongeldig`);
    if (!Number.isFinite(step.power_w) || step.power_w < 0 || step.power_w > 10000) errors.push(`steps[${index}].power_w ongeldig`);
  }
  if (Array.isArray(profile?.steps) && profile.steps.every((step) => step.power_w === 0)) errors.push('apparaatprofiel heeft geen energieverbruik');
  if (profile.min_solar_share !== undefined && (!Number.isFinite(profile.min_solar_share) || profile.min_solar_share < 0 || profile.min_solar_share > 1)) errors.push('min_solar_share moet 0..1 zijn');
  if (profile.reserve_w !== undefined && (!Number.isFinite(profile.reserve_w) || profile.reserve_w < 0)) errors.push('reserve_w moet >=0 zijn');
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
      if (profiles.has(profile.id)) violations.push(`dubbel apparaat-id ${profile.id}`);
      if (violations.length) errors.push({ file, errors: violations });
      else profiles.set(profile.id, { ...profile, duration_minutes: profile.steps.reduce((total, item) => total + item.duration_minutes, 0) });
    } catch (error) { errors.push({ file, errors: [error.message] }); }
  }
  return { profiles, errors };
}
