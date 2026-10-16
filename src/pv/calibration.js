/** Leest en valideert de opbrengstkalibratie; input: instellingen met optionele pv.calibration_factor; output: factor >0 en <=10 of fout, standaard 1. */
export function getCalibrationFactor(settings) {
  const config = settings.pv;
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) throw new Error('pv moet een object met calibration_factor zijn');
  const factor = config?.calibration_factor === undefined ? 1 : config.calibration_factor;
  if (!Number.isFinite(factor) || factor <= 0 || factor > 10) throw new Error('pv.calibration_factor moet een getal >0 en <=10 zijn');
  return factor;
}
