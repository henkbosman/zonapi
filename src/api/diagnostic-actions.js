/** Verwerkt logbeheer voor de drie bronnen; input: methode, URL en repository; output: JSON-resultaat of null voor een andere route. */
export function diagnosticAction(method, url, repository) {
  const match = /^\/intern\/api\/v1\/(growatt|weather|homewizard)\/(logging|diagnostics)$/.exec(url.pathname);
  if (!match) return null;
  const [, source, action] = match;
  if (action === 'logging' && method === 'GET') return repository.loggingStatus(source);
  if (action === 'logging' && method === 'PUT') {
    const enabled = url.searchParams.get('enabled');
    if (!['true', 'false'].includes(enabled)) throw new Error('enabled moet true of false zijn');
    return repository.setLogging(source, enabled === 'true');
  }
  if (action === 'diagnostics' && method === 'DELETE') {
    const clear = { growatt: repository.clearGrowattDiagnostics, weather: repository.clearWeatherDiagnostics, homewizard: repository.clearHomeWizardDiagnostics };
    return clear[source]();
  }
  return null;
}
