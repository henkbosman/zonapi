/** Past een automatische factor op AC-groepswaarden toe met behoud van omvormerlimieten; input: basisberekening, paneelconfig en factor; output: gecorrigeerde groepen, totaal en basisvermogen. */
export function applyPvCorrection(base, panels, factor) {
  const groups = [];
  for (const inverter of panels.inverters) {
    const entries = base.groups.filter((group) => group.inverter_id === inverter.id);
    const total = entries.reduce((sum, group) => sum + group.power_w, 0);
    const corrected = Math.round(Math.min(inverter.ac_limit_w, total * factor) * 10) / 10;
    let assigned = 0;
    for (let index = 0; index < entries.length; index++) {
      const group = entries[index];
      const power = index === entries.length - 1 ? Math.round((corrected - assigned) * 10) / 10
        : Math.round((total ? corrected * group.power_w / total : 0) * 10) / 10;
      assigned += power;
      groups.push({ ...group, base_power_w: group.power_w, power_w: power });
    }
  }
  return { power_w: Math.round(groups.reduce((sum, group) => sum + group.power_w, 0) * 10) / 10,
    base_power_w: base.power_w, correction_factor: factor, groups };
}
