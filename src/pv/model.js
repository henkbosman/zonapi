import { tiltedIrradiance } from './plane-irradiance.js';

/** Berekent per omvormer geknipte AC-opbrengst; input: weeruur, paneelconfig, locatie; output: {power_w,groups} of fout. */
export function estimatePv(row, panels, latitude, longitude) {
  const byInverter = new Map(panels.inverters.map((inverter) => [inverter.id, { inverter, groups: [], dc: 0 }]));
  for (const group of panels.groups) {
    const gti = tiltedIrradiance(row, group, latitude, longitude);
    const dc = group.count * group.wp_per_panel * gti / 1000 * group.loss_factor;
    const inv = byInverter.get(group.inverter_id);
    if (!inv || !Number.isFinite(dc)) throw new Error('Paneelgroep ongeldig; vul paneelconfiguratie in');
    inv.dc += dc;
    inv.groups.push({ group_id: group.id, gti_w_m2: Math.round(gti * 10) / 10, dc_w: dc });
  }
  const groups = [];
  for (const { inverter, groups: entries, dc } of byInverter.values()) {
    const ac = Math.min(inverter.ac_limit_w, dc);
    for (const group of entries) groups.push({ group_id: group.group_id, inverter_id: inverter.id, gti_w_m2: group.gti_w_m2, power_w: Math.round(ac * (dc ? group.dc_w / dc : 0) * 10) / 10 });
  }
  return { power_w: Math.round(groups.reduce((sum, group) => sum + group.power_w, 0) * 10) / 10, groups };
}
