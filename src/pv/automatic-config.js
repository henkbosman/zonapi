/** Leest de automatische opbrengstcorrectie; input: applicatie-instellingen; output: gevalideerde configuratie of fout. */
export function automaticCorrectionConfig(settings) {
  const supplied = settings.pv?.automatic_correction === undefined ? {} : settings.pv.automatic_correction;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('pv.automatic_correction moet een object zijn');
  const config = { enabled: true, mode: 'per_block', min_forecast_w: 100, max_cloud_cover_percent: 0, max_factor: 3, max_skew_seconds: 300,
    sample_tolerance_seconds: 150, outlier_relative: 0.35, outlier_min_w: 200, ...supplied };
  // De oude standaard liet op iedere vijfminutenklok een gat van twee minuten vallen.
  // Bestaande settings.json-bestanden krijgen dezelfde herstelde standaard zonder overschrijven.
  if (config.sample_tolerance_seconds === 90) config.sample_tolerance_seconds = 150;
  if (typeof config.enabled !== 'boolean') throw new Error('pv.automatic_correction.enabled moet true of false zijn');
  if (!['per_block', 'live_today_pattern', 'pattern'].includes(config.mode)) throw new Error('pv.automatic_correction.mode moet per_block zijn');
  // Oude instellingen blijven leesbaar; elk klokkwartier behoudt zijn eigen onafhankelijke factor.
  config.mode = 'per_block';
  if (!Number.isFinite(config.min_forecast_w) || config.min_forecast_w <= 0 || config.min_forecast_w > 20000) throw new Error('pv.automatic_correction.min_forecast_w moet >0 en <=20000 zijn');
  if (!Number.isFinite(config.max_cloud_cover_percent) || config.max_cloud_cover_percent < 0 || config.max_cloud_cover_percent > 100) throw new Error('pv.automatic_correction.max_cloud_cover_percent moet een getal van 0..100 zijn');
  if (!Number.isFinite(config.max_factor) || config.max_factor < 1 || config.max_factor > 10) throw new Error('pv.automatic_correction.max_factor moet 1..10 zijn');
  if (!Number.isInteger(config.max_skew_seconds) || config.max_skew_seconds < 0 || config.max_skew_seconds > 3600) throw new Error('pv.automatic_correction.max_skew_seconds moet 0..3600 zijn');
  if (!Number.isInteger(config.sample_tolerance_seconds) || config.sample_tolerance_seconds < 0 || config.sample_tolerance_seconds > 150) throw new Error('pv.automatic_correction.sample_tolerance_seconds moet 0..150 zijn');
  if (!Number.isFinite(config.outlier_relative) || config.outlier_relative <= 0 || config.outlier_relative > 2) throw new Error('pv.automatic_correction.outlier_relative moet >0 en <=2 zijn');
  if (!Number.isFinite(config.outlier_min_w) || config.outlier_min_w < 0 || config.outlier_min_w > 20000) throw new Error('pv.automatic_correction.outlier_min_w moet 0..20000 zijn');
  return config;
}
