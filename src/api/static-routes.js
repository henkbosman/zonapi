import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../config/load.js';

const dashboardFiles = ['dashboard.css', 'dashboard.js', 'chart-cursor.js', 'dashboard-daily-advice.js',
  'dashboard-appliance-charts.js', 'appliance-cycle-chart.js', 'dashboard-production-chart.js',
  'dashboard-production-days.js', 'pv-correction-status.js', 'production-chart-series.js'];
const internalFiles = ['database.js', 'database.css', 'homewizard.js', 'diagnostic-controls.js',
  'growatt.css', 'growatt.js', 'growatt-cloud.js', 'growatt-production.js', 'weather.css', 'weather.js', 'weather-chart.js'];
const publicRoutes = new Map([['/', 'index.html'], ['/dashboard', 'index.html'], ...dashboardFiles.map((name) => ['/' + name, name])]);
const internalRoutes = new Map([['/intern', 'growatt.html'], ['/intern/', 'growatt.html'],
  ...['growatt', 'weather', 'homewizard', 'database'].map((name) => ['/intern/' + name, name + '.html']),
  ...[...dashboardFiles, ...internalFiles].map((name) => ['/intern/' + name, name])]);
const mimeTypes = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8' };

/** Serveert uitsluitend een expliciet openbaar of intern bestand; input: antwoord, volledig pad en gekozen routetabel; output: true bij een verzonden bestand, anders false. */
export function serveStatic(response, pathname, internal) {
  const file = (internal ? internalRoutes : publicRoutes).get(pathname);
  if (!file) return false;
  response.writeHead(200, { 'Content-Type': mimeTypes[file.split('.').at(-1)], 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff' });
  response.end(readFileSync(join(root, 'public', file)));
  return true;
}
