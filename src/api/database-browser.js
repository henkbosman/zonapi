const pageSizes = [10, 25, 50, 100, 250, 500];

/** Quote een reeds uit SQLite gecontroleerde identifier; input: tabel-/kolomnaam; output: SQL-identifier. */
function identifier(value) { return `"${value.replaceAll('"', '""')}"`; }

/** Leest alleen echte toepassingstabellen; input: SQLite; output: namen en schema-eigenschappen. */
function tables(db) {
  return db.prepare("SELECT name, wr FROM pragma_table_list WHERE schema='main' AND type IN ('table','virtual') AND substr(name,1,7)<>'sqlite_' ORDER BY name COLLATE NOCASE,name").all();
}

/** Leest alle zichtbare kolommen, inclusief gegenereerde kolommen; input: SQLite en gecontroleerde tabelnaam; output: kolommetadata. */
function columns(db, table) {
  return db.prepare('SELECT name,type,"notnull",pk FROM pragma_table_xinfo(?) WHERE hidden<>1 ORDER BY cid').all(table)
    .map((column) => ({ name: column.name, type: column.type || 'ANY', nullable: !column.notnull, primary_key: column.pk }));
}

/** Levert de tabelkeuze zonder gegevens te wijzigen; input: SQLite; output: catalogus en paginagroottes. */
export function databaseCatalog(db) {
  return { page_sizes: pageSizes, tables: tables(db).map((table) => ({ name: table.name, columns: columns(db, table.name) })) };
}

/** Controleert een positieve, veilige pagina-instelling; input: tekst, standaard en veldnaam; output: geheel getal of fout. */
function positive(value, fallback, name) {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} moet een positief geheel getal zijn`);
  return Number(value);
}

/** Zet BLOBs en grote integers zonder afkappen om naar JSON; input: SQLite-waarde; output: JSON-waarde. */
function cellValue(value) {
  if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex').toUpperCase()}`;
  return value;
}

/** Doorzoekt en sorteert één tabel met gebonden filterwaarden; input: SQLite en URLSearchParams; output: volledige, gepagineerde rijen zonder schrijfacties. */
export function databaseRows(db, params) {
  const table = tables(db).find((item) => item.name === params.get('table'));
  if (!table) throw new Error('Onbekende tabel');
  const metadata = columns(db, table.name), names = new Set(metadata.map((column) => column.name));
  const size = positive(params.get('page_size'), 50, 'page_size');
  if (!pageSizes.includes(size)) throw new Error(`page_size moet ${pageSizes.join(', ')} zijn`);
  const requestedPage = positive(params.get('page'), 1, 'page');
  const sort = params.get('sort') ?? metadata.find((column) => column.primary_key)?.name ?? metadata[0].name;
  if (!names.has(sort)) throw new Error('Onbekende sorteerkolom');
  const direction = params.get('direction') ?? 'asc';
  if (!['asc', 'desc'].includes(direction)) throw new Error('direction moet asc of desc zijn');
  let filters;
  try { filters = JSON.parse(params.get('filters') ?? '[]'); } catch { throw new Error('filters moet een JSON-lijst zijn'); }
  if (!Array.isArray(filters) || filters.length > metadata.length) throw new Error('Ongeldige kolomfilters');
  const seen = new Set(), clauses = [], values = [];
  for (const filter of filters) {
    if (!filter || typeof filter !== 'object' || !names.has(filter.column) || seen.has(filter.column) || typeof filter.value !== 'string' || filter.value.length > 2000) throw new Error('Ongeldig kolomfilter');
    seen.add(filter.column);
    if (!filter.value) continue;
    const column = identifier(filter.column);
    const display = `CASE WHEN typeof(${column})='blob' THEN '0x'||hex(${column}) ELSE COALESCE(CAST(${column} AS TEXT),'NULL') END`;
    clauses.push(`instr(lower(${display}),lower(?))>0`);
    values.push(filter.value);
  }
  const from = `FROM ${identifier(table.name)}`, where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count ${from}`).get().count;
  const filtered = clauses.length ? db.prepare(`SELECT COUNT(*) AS count ${from}${where}`).get(...values).count : total;
  const pages = Math.max(1, Math.ceil(filtered / size)), page = Math.min(requestedPage, pages), offset = (page - 1) * size;
  const order = [`${identifier(sort)} ${direction.toUpperCase()}`];
  // Een vaste tweede sleutel voorkomt dat gelijke sorteerwaarden tussen pagina's wisselen.
  const keys = metadata.filter((column) => column.primary_key).sort((a, b) => a.primary_key - b.primary_key);
  for (const column of keys) if (column.name !== sort) order.push(`${identifier(column.name)} ASC`);
  const rowid = !table.wr && ['rowid', '_rowid_', 'oid'].find((name) => ![...names].some((column) => column.toLowerCase() === name));
  if (rowid) order.push(`${identifier(rowid)} ASC`);
  const statement = db.prepare(`SELECT ${metadata.map((column) => identifier(column.name)).join(',')} ${from}${where} ORDER BY ${order.join(',')} LIMIT ? OFFSET ?`);
  statement.setReadBigInts(true); statement.setReturnArrays(true);
  return { table: table.name, columns: metadata, total_rows: total, filtered_rows: filtered, page, page_size: size, total_pages: pages,
    sort, direction, rows: statement.all(...values, size, offset).map((row) => row.map(cellValue)) };
}
