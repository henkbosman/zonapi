/** Maakt een vaste API-sleutel van een programmanaam; input: naam en positie; output: id zonder bijzondere tekens. */
export function programId(name, index) {
  return name.trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `programma-${index + 1}`;
}

/** Leest benoemde programma's of het bestaande stappenprofiel; input: geldig apparaat; output: programma's met berekende duur en stabiele ids. */
export function appliancePrograms(profile) {
  const values = profile.programs ?? [{ id: 'standaard', name: 'Standaard', steps: profile.steps }];
  return values.map((value, index) => ({ ...value, id: value.id ?? programId(value.name, index), name: value.name.trim(),
    duration_minutes: value.steps.reduce((sum, step) => sum + step.duration_minutes, 0) }));
}

/** Bepaalt de effectieve apparaatdrempel; input: apparaat en instellingen; output: fractie, percentage en bron, met nul als geldige eigen waarde. */
export function minimumSolarShare(profile, settings) {
  const value = profile.min_solar_share ?? settings.advice.min_solar_share;
  return { value, percent: value * 100, source: profile.min_solar_share == null ? 'general' : 'appliance' };
}

/** Maakt een cyclus voor het advies zonder de fysieke apparaat-id te wijzigen; input: apparaat en programma; output: adviesprofiel met eigen stappen en programmanaam. */
export function programProfile(profile, program) {
  return { ...profile, program_id: program.id, program_name: program.name, steps: program.steps,
    duration_minutes: program.duration_minutes };
}

/** Reserveert per fase het hoogste vermogen van de mogelijke programma's; input: fysiek apparaat; output: één voorzichtig profiel, nooit de som van alternatieve programma's. */
export function programEnvelope(profile) {
  const programs = appliancePrograms(profile);
  if (programs.length === 1) return programs[0].steps;
  const boundaries = new Set([0]);
  const segments = programs.map((program) => {
    let from = 0;
    return program.steps.map((step) => {
      const until = from + step.duration_minutes;
      boundaries.add(until);
      const result = { from, until, power_w: step.power_w }; from = until; return result;
    });
  });
  const ordered = [...boundaries].sort((a, b) => a - b);
  return ordered.slice(1).map((until, index) => ({ duration_minutes: until - ordered[index],
    power_w: Math.max(...segments.map((items) => items.find((item) => item.from <= ordered[index] && item.until > ordered[index])?.power_w ?? 0)) }));
}
