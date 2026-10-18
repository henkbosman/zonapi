/** Verbindt brongebonden logschakelaars en wisknoppen; input: bron, vernieuwfunctie en optionele callback na wissen; output: functie om de logstatus te tonen. */
export function setupDiagnosticControls(source, refresh, afterClear = () => {}) {
  const toggle = document.querySelector('#toggle-logging');
  const clear = document.querySelector('#clear-logs');
  let enabled = true;
  let busy = false;

  /** Toont de op de server bewaarde logstatus; input: {enabled,max_entries}; output: void. */
  function render(logging) {
    enabled = logging.enabled;
    toggle.textContent = enabled ? 'Logging aan' : 'Logging uit';
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.dataset.enabled = String(enabled);
    toggle.title = logging.error ?? '';
    if (!busy) toggle.disabled = false;
  }

  /** Voert één logwijziging uit en leest daarna de actuele pagina; input: actie en fetch-opties; output: Promise<void>. */
  async function change(action, options) {
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    clear.disabled = true;
    try {
      const response = await fetch(`/intern/api/v1/${source}/${action}`, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...options });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      if (action.startsWith('logging')) render(body);
      else afterClear();
      await refresh();
    } catch (error) { document.querySelector('#connection').textContent = `Fout: ${error.message}`; }
    finally { busy = false; toggle.disabled = false; clear.disabled = false; }
  }

  toggle.addEventListener('click', () => { void change(`logging?enabled=${!enabled}`, { method: 'PUT' }); });
  clear.addEventListener('click', () => {
    if (window.confirm('Berichten en logs verwijderen?')) void change('diagnostics', { method: 'DELETE' });
  });
  return render;
}
