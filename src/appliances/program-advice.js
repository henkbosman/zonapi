import { advise } from './start-advice.js';
import { appliancePrograms, minimumSolarShare, programProfile } from './programs.js';

/** Koppelt het advies aan een benoemd programma; input: programma en berekend advies; output: programmanaam, duur en adviesvelden. */
export function describeProgramAdvice(program, advice) {
  return { ...advice, id: program.id, name: program.name, program_id: program.id, program_name: program.name, duration_minutes: program.duration_minutes };
}

/** Behoudt het bestaande apparaatadvies en noemt het bijbehorende programma; input: apparaat, programma-adviezen en instellingen; output: samenvatting met afzonderlijke alternatieven. */
export function combineProgramAdvice(profile, programs, settings) {
  const usable = programs.length === 1 ? programs : programs.filter((row) => row.status === 'ok');
  const earliest = usable.filter((row) => row.earliest_start).sort((a, b) => Date.parse(a.earliest_start) - Date.parse(b.earliest_start))[0];
  const best = usable.filter((row) => row.best_start && row.best).sort((a, b) =>
    b.best.solar_share - a.best.solar_share || Date.parse(a.best_start) - Date.parse(b.best_start))[0];
  const selected = earliest ?? best ?? usable[0] ?? programs[0];
  const now = programs.some((row) => row.can_start_now === true) ? true : programs.every((row) => row.can_start_now === false) ? false : null;
  const minimum = minimumSolarShare(profile, settings);
  return { ...selected, id: profile.id, name: profile.name, can_start_now: now,
    minimum_solar_share_percent: minimum.percent, minimum_solar_share_source: minimum.source,
    earliest_start: earliest?.earliest_start ?? null, earliest: earliest?.earliest ?? null,
    best_start: best?.best_start ?? null, best: best?.best ?? null,
    best_program_id: best?.program_id ?? null, best_program_name: best?.program_name ?? null, programs };
}

/** Adviseert ieder alternatief van één fysiek apparaat; input: profiel, weer, modelcontext en optionele programmakeuze; output: apparaatadvies inclusief programma-adviezen. */
export function adviseAppliance(profile, weather, context, chosenProgram = null) {
  const programs = appliancePrograms(profile).filter((program) => chosenProgram === null || program.id === chosenProgram || program.name === chosenProgram);
  if (!programs.length) throw new Error('Onbekend programma');
  const predictions = context.predictions ?? new Map();
  return combineProgramAdvice(profile, programs.map((program) => describeProgramAdvice(program,
    advise(programProfile(profile, program), weather, { ...context, predictions }))), context.settings);
}
