/** Leest een pagina uit de lokale database-API; input: URL en abortsignaal; output: JSON of fout. */
async function requestJson(path, signal) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/** Verbindt tabelkeuze, filters en paginering; input: optioneel document, JSON-lezer en filtervertraging; output: initialisatiebelofte. */
export function setupDatabasePage({ document: doc = globalThis.document, request = requestJson, filterDelayMs = 300 } = {}) {
  const element = (id) => doc.getElementById(id);
  const state = { tables: [], table: null, columns: [], filters: new Map(), page: 1, pages: 1, size: 50, sort: null, direction: 'asc', busy: false };
  let generation = 0, controller = null, filterTimer = null;
  const filterInputs = new Map(), headers = new Map();

  /** Maakt een veilig tekstelement; input: tag, tekst en optionele klassenaam; output: DOM-element. */
  function node(tag, text = '', className = '') {
    const item = doc.createElement(tag); item.textContent = text; if (className) item.className = className; return item;
  }

  /** Stelt alleen geldige paginaknoppen beschikbaar; input: geen; output: void. */
  function updateControls() {
    const disabled = !state.table || state.busy;
    for (const id of ['page-size', 'page-number', 'go-page']) element(id).disabled = disabled;
    for (const id of ['first-page', 'previous-page']) element(id).disabled = disabled || state.page <= 1;
    for (const id of ['next-page', 'last-page']) element(id).disabled = disabled || state.page >= state.pages;
    element('clear-filters').disabled = !state.table || !state.filters.size;
    element('page-number').value = String(state.page); element('page-number').max = String(state.pages);
    element('page-total').textContent = `van ${state.pages.toLocaleString('nl-NL')}`;
    element('database-table').setAttribute('aria-busy', String(state.busy));
    for (const [name, header] of headers) {
      header.cell.setAttribute('aria-sort', state.sort === name ? state.direction === 'asc' ? 'ascending' : 'descending' : 'none');
      header.indicator.textContent = state.sort === name ? state.direction === 'asc' ? '↑' : '↓' : '↕';
      header.button.setAttribute('aria-label', `Sorteer ${name} ${state.sort === name && state.direction === 'asc' ? 'aflopend' : 'oplopend'}`);
    }
  }

  /** Toont een melding over de volle tabelbreedte; input: tekst; output: void. */
  function empty(message) {
    const cell = node('td', message, 'empty-row'); cell.colSpan = Math.max(1, state.columns.length);
    const row = node('tr'); row.append(cell); element('database-rows').replaceChildren(row);
  }

  /** Maakt eerdere aanvragen ongeldig, ook tijdens filtervertraging; input: geen; output: void. */
  function invalidate() { generation++; controller?.abort(); clearTimeout(filterTimer); }

  /** Haalt de actuele selectie op, met bescherming tegen vertraagde oude antwoorden; input: geen; output: Promise<void>. */
  async function loadRows() {
    if (!state.table) return;
    invalidate(); const id = generation; controller = new AbortController();
    const query = new URLSearchParams({ table: state.table, page: String(state.page), page_size: String(state.size),
      sort: state.sort, direction: state.direction, filters: JSON.stringify([...state.filters].map(([column, value]) => ({ column, value }))) });
    state.busy = true; updateControls(); element('connection').textContent = 'Records ophalen…';
    element('record-count').textContent = 'Gegevens ophalen…';
    try {
      const data = await request(`/api/v1/database/rows?${query}`, controller.signal);
      if (id !== generation) return;
      state.page = data.page; state.pages = data.total_pages;
      const body = element('database-rows'); body.replaceChildren();
      for (const values of data.rows) {
        const row = node('tr');
        for (const value of values) {
          const cell = node('td'), content = node('div', value === null ? 'NULL' : typeof value === 'string' && value === '' ? '""' : String(value), `database-cell${value === null ? ' cell-null' : ''}`);
          cell.append(content); row.append(cell);
        }
        body.append(row);
      }
      if (!data.rows.length) empty(data.total_rows ? 'Geen records voor deze filters.' : 'Deze tabel is leeg.');
      const first = data.rows.length ? (data.page - 1) * data.page_size + 1 : 0, last = first ? first + data.rows.length - 1 : 0;
      const format = (value) => value.toLocaleString('nl-NL');
      element('record-count').textContent = `${format(first)}–${format(last)} van ${format(data.filtered_rows)} records${state.filters.size ? ` · ${format(data.total_rows)} in de tabel` : ''}`;
      element('connection').textContent = 'Bijgewerkt';
    } catch (error) {
      if (id !== generation) return;
      empty(`Kon records niet ophalen: ${error.message}`);
      element('record-count').textContent = 'Gegevens niet beschikbaar';
      element('connection').textContent = `Fout: ${error.message}`;
      state.page = 1; state.pages = 1;
    } finally { if (id === generation) { state.busy = false; updateControls(); } }
  }

  /** Maakt sorteerbare kolommen en afzonderlijke filters; input: geen; output: void. */
  function renderHeader() {
    const row = node('tr'); filterInputs.clear(); headers.clear();
    for (const column of state.columns) {
      const cell = node('th'); cell.scope = 'col';
      const button = node('button'); button.type = 'button';
      const indicator = node('span'); indicator.setAttribute('aria-hidden', 'true');
      button.append(node('span', column.name), indicator);
      button.addEventListener('click', () => {
        state.direction = state.sort === column.name && state.direction === 'asc' ? 'desc' : 'asc';
        state.sort = column.name; state.page = 1; void loadRows();
      });
      const input = node('input'); input.type = 'search'; input.placeholder = 'Filter…'; input.maxLength = 2000;
      input.setAttribute('aria-label', `Filter ${column.name}`);
      input.addEventListener('input', () => {
        if (input.value) state.filters.set(column.name, input.value); else state.filters.delete(column.name);
        state.page = 1; invalidate(); state.busy = true; updateControls();
        filterTimer = setTimeout(() => { void loadRows(); }, filterDelayMs);
      });
      filterInputs.set(column.name, input); headers.set(column.name, { cell, button, indicator });
      cell.append(button, node('span', `${column.type}${column.primary_key ? ' · sleutel' : ''}`, 'database-column-type'), input);
      row.append(cell);
    }
    element('database-head').replaceChildren(row); updateControls();
  }

  /** Kiest een tabel met schone filters en eerste pagina; input: catalogusitem; output: void. */
  function choose(table) {
    invalidate(); state.table = table.name; state.columns = table.columns; state.filters.clear();
    state.page = 1; state.pages = 1; state.sort = table.columns.find((column) => column.primary_key)?.name ?? table.columns[0].name; state.direction = 'asc';
    element('table-name').textContent = table.name; element('table-caption').textContent = `Inhoud van ${table.name}`;
    element('table-dialog').close(); renderHeader(); empty('Records ophalen…'); void loadRows();
  }

  /** Toont gezochte tabelnamen als selecteerbare knoppen; input: geen; output: void. */
  function renderTableOptions() {
    const query = element('table-search').value.toLocaleLowerCase('nl-NL');
    const matches = state.tables.filter((table) => table.name.toLocaleLowerCase('nl-NL').includes(query));
    const list = element('table-options'); list.replaceChildren();
    for (const table of matches) {
      const button = node('button'); button.type = 'button'; button.setAttribute('aria-pressed', String(state.table === table.name));
      button.append(node('span', table.name), node('span', `${table.columns.length} kolommen`));
      button.addEventListener('click', () => choose(table)); list.append(button);
    }
    if (!matches.length) list.append(node('p', 'Geen tabellen gevonden.', 'database-summary'));
    element('table-options-count').textContent = `${matches.length} van ${state.tables.length} tabellen`;
  }

  function openDialog() { element('table-search').value = ''; renderTableOptions(); element('table-dialog').showModal(); element('table-search').focus(); }
  element('choose-table').addEventListener('click', openDialog);
  element('close-dialog').addEventListener('click', () => element('table-dialog').close());
  element('table-search').addEventListener('input', renderTableOptions);
  element('page-size').addEventListener('change', () => { state.size = Number(element('page-size').value); state.page = 1; void loadRows(); });
  element('clear-filters').addEventListener('click', () => {
    state.filters.clear(); for (const input of filterInputs.values()) input.value = ''; state.page = 1; void loadRows();
  });
  for (const [id, page] of [['first-page', () => 1], ['previous-page', () => state.page - 1], ['next-page', () => state.page + 1], ['last-page', () => state.pages]]) {
    element(id).addEventListener('click', () => { state.page = page(); void loadRows(); });
  }
  element('page-form').addEventListener('submit', (event) => {
    event.preventDefault(); const page = Number(element('page-number').value);
    if (Number.isSafeInteger(page) && page >= 1 && page <= state.pages) { state.page = page; void loadRows(); }
  });
  element('refresh-now').addEventListener('click', () => { if (state.table) void loadRows(); else void initialize(); });

  /** Haalt de tabelcatalogus op en opent de keuze; input: geen; output: Promise<void>. */
  async function initialize() {
    invalidate(); const id = generation; controller = new AbortController();
    element('connection').textContent = 'Tabellen ophalen…';
    try {
      const catalog = await request('/api/v1/database/tables', controller.signal);
      if (id !== generation) return;
      state.tables = catalog.tables;
      const sizes = element('page-size'); sizes.replaceChildren();
      for (const size of catalog.page_sizes) { const option = node('option', String(size)); option.value = String(size); sizes.append(option); }
      sizes.value = String(state.size); element('choose-table').disabled = !state.tables.length;
      element('connection').textContent = `${state.tables.length} tabellen beschikbaar`;
      if (state.tables.length) openDialog(); else empty('Er zijn geen tabellen beschikbaar.');
    } catch (error) { if (id === generation) element('connection').textContent = `Fout: ${error.message}`; }
  }
  return initialize();
}

if (typeof document !== 'undefined') void setupDatabasePage();
