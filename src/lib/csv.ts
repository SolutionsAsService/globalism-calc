/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF, BOM). Returns rows of strings. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parse CSV into objects keyed by the header row. skipLines drops preamble lines (e.g. World Bank CSVs have 4). */
export function csvToObjects(text: string, opts: { delimiter?: string; skipLines?: number } = {}): Record<string, string>[] {
  let rows = parseCsv(text, opts.delimiter ?? ',');
  rows = rows.slice(opts.skipLines ?? 0);
  const [header, ...body] = rows;
  if (!header) return [];
  const h = header.map((x) => x.trim());
  return body.map((r) => Object.fromEntries(h.map((k, j) => [k, r[j] ?? ''])));
}
