import type { Dataset, DatasetMeta, DatasetRow, DatasetSeries, Entity, ImportReport } from './types';
import { buildMatcher, type AliasFile } from './names';
import { csvToObjects } from './csv';
import { flattenEiaSeriesExport } from './eia';

/**
 * A source spec (data/sources/<id>.source.json) describes how to turn one raw file into a normalized dataset.
 * See README "Adding a dataset".
 */
export interface SourceSpec {
  /** Path of the raw file, relative to the repo root. */
  input: string;
  /** eia-series: EIA International "SeriesExport" JSON; flattened to rows with iso, productid, activityid, unit, year, value, flag, marker. */
  format: 'json' | 'csv' | 'eia-series';
  /** JSON only: dot path to the array of row objects (e.g. "countries" or "data.items"). Omit if the file is an array. */
  rowsPath?: string;
  /** CSV only. */
  csv?: { delimiter?: string; skipLines?: number };
  /** Column/field holding the entity name or code (ISO3, ISO2 or entity key; names are matched via aliases). */
  entityField: string;
  /** Used when entityField is empty in a row (e.g. OWID: iso_code is blank for regions and Kosovo, so the "country" name is matched instead). */
  entityFallbackField?: string;
  /** Long format only: ignore rows before this year (keeps generated files small; recorded in import.minYear). */
  minYear?: number;
  /** Column/field holding the value. Use valueColumns instead for wide year-column files. */
  valueField?: string;
  /** Wide files (e.g. World Bank CSV): candidate year columns; the most recent non-empty one is used. */
  valueColumns?: string[];
  /** Column/field holding the year (long format). The latest year with a value is kept per entity. */
  yearField?: string;
  /** Fixed year when the file has no year field. */
  year?: number;
  /** Multiply raw values (e.g. 1000 when the source is in thousands). Default 1. */
  scale?: number;
  /** Optional filter: only keep rows where row[field] === value (e.g. a product or indicator code). */
  where?: Record<string, string>;
  /** Field holding the unit of each row; every kept row must have unit === dataset.indicator.unit (no unit guessing). */
  unitField?: string;
  /** Field holding a source flag for the value (copied to the output row as `flag`). */
  flagField?: string;
  /** Field holding a non-numeric source marker (e.g. "NA"); counted in import.markers. */
  markerField?: string;
  /** Long format only: also keep the full annual series per entity (Dataset.series), e.g. for trend charts and derived datasets. */
  keepSeries?: boolean;
  /** Fail when a label can't be matched (default true). Set false only while exploring. */
  strict?: boolean;
  dataset: DatasetMeta;
}

const MISSING = new Set(['', '..', 'na', 'n/a', 'nan', 'null', '-', '—', 'none']);

/** Parse a number from a raw cell; returns null for blanks and common missing markers. Never guesses. */
export function parseValue(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (MISSING.has(s.toLowerCase())) return null;
  const n = Number(s.replace(/,/g, '').replace(/%$/, ''));
  if (!Number.isFinite(n)) throw new Error(`Unparseable numeric value: "${s}"`);
  return n;
}

function getPath(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

/** readRows memoized per input file and format (the OWID CSV feeds many specs; parse it once per process). */
const rowCache = new Map<string, Record<string, unknown>[]>();
export function readRowsCached(spec: SourceSpec, readText: (path: string) => string): Record<string, unknown>[] {
  const k = `${spec.format}|${JSON.stringify(spec.csv ?? {})}|${spec.rowsPath ?? ''}|${spec.input}`;
  let rows = rowCache.get(k);
  if (!rows) { rows = readRows(spec, readText(spec.input)); rowCache.set(k, rows); }
  return rows;
}

export function readRows(spec: SourceSpec, text: string): Record<string, unknown>[] {
  if (spec.format === 'csv') return csvToObjects(text, spec.csv);
  if (spec.format === 'eia-series') return flattenEiaSeriesExport(text) as unknown as Record<string, unknown>[];
  const parsed = JSON.parse(text);
  const rows = getPath(parsed, spec.rowsPath);
  if (!Array.isArray(rows)) throw new Error(`rowsPath "${spec.rowsPath ?? ''}" did not resolve to an array`);
  return rows as Record<string, unknown>[];
}

export class UnmatchedError extends Error {
  constructor(public labels: string[], specPath: string) {
    super(
      `${specPath}: ${labels.length} unmatched entity label(s): ${labels.map((l) => JSON.stringify(l)).join(', ')}.\n` +
        'Add each to data/reference/aliases.json under "aliases" (label -> entity key) or "nonEntities" (label -> reason).',
    );
  }
}

/** Convert raw rows to a normalized Dataset. Pure: no file system access. */
export function normalize(
  spec: SourceSpec,
  rows: Record<string, unknown>[],
  entities: Entity[],
  aliasFile: AliasFile,
  specPath = 'spec',
): Dataset {
  const matcher = buildMatcher(entities, aliasFile);
  const scale = spec.scale ?? 1;
  const skipped: ImportReport['skipped'] = [];
  const unmatched: string[] = [];
  const best = new Map<string, DatasetRow & { names: Set<string> }>();
  const duplicates = new Map<string, Set<string>>();
  const markers: Record<string, number> = {};
  const series = new Map<string, Map<number, { value: number | null; flag?: string }>>();
  if (spec.keepSeries && !spec.yearField && spec.year === undefined) throw new Error(`${specPath}: keepSeries requires yearField or year`);
  let rowsRead = 0;

  for (const r of rows) {
    if (spec.where && !Object.entries(spec.where).every(([k, v]) => String(r[k] ?? '') === v)) continue;
    if (spec.minYear !== undefined && spec.yearField && r[spec.yearField] != null && r[spec.yearField] !== '' && Number(r[spec.yearField]) < spec.minYear) continue;
    rowsRead++;
    if (spec.markerField && r[spec.markerField] != null) {
      const mk = String(r[spec.markerField]);
      markers[mk] = (markers[mk] ?? 0) + 1;
    }
    let label = String(r[spec.entityField] ?? '').trim();
    if (!label && spec.entityFallbackField) label = String(r[spec.entityFallbackField] ?? '').trim();
    if (!label) continue;
    const m = matcher.match(label);
    if (!m) { unmatched.push(label); continue; }
    if ('skip' in m) { if (!skipped.some((s) => s.name === label)) skipped.push({ name: label, reason: m.skip }); continue; }
    if (spec.unitField && String(r[spec.unitField] ?? '') !== spec.dataset.indicator.unit) {
      throw new Error(`${specPath}: "${label}" has unit "${String(r[spec.unitField] ?? '')}" but the dataset declares "${spec.dataset.indicator.unit}"`);
    }
    const flagRaw = spec.flagField ? r[spec.flagField] : undefined;
    const flag = flagRaw != null && flagRaw !== '' ? String(flagRaw) : undefined;

    let value: number | null = null;
    let year: number | undefined = spec.year;
    if (spec.valueColumns) {
      for (const col of [...spec.valueColumns].sort((a, b) => Number(b) - Number(a))) {
        const v = parseValue(r[col]);
        if (v !== null) { value = v; year = Number(col); break; }
      }
      year ??= Math.max(...spec.valueColumns.map(Number));
    } else {
      if (!spec.valueField) throw new Error(`${specPath}: valueField or valueColumns is required`);
      value = parseValue(r[spec.valueField]);
      if (spec.yearField) {
        const y = r[spec.yearField];
        // "Most recent value" tables leave the year blank when there is no value: keep the row as missing at the dataset year.
        year = (y == null || y === '') && value === null ? (spec.year ?? spec.dataset.year) : Number(y);
      }
    }
    if (year === undefined || !Number.isFinite(year)) throw new Error(`${specPath}: no year for "${label}" (set year, yearField or valueColumns)`);
    if (value !== null) value *= scale;
    if (spec.keepSeries) {
      const s = series.get(m.key) ?? new Map();
      s.set(year, { value, ...(flag ? { flag } : {}) });
      series.set(m.key, s);
    }

    const prev = best.get(m.key);
    if (!prev) { best.set(m.key, { key: m.key, value, year, sourceName: label, ...(flag ? { flag } : {}), names: new Set([label]) }); continue; }
    prev.names.add(label);
    if (spec.yearField && prev.year !== year) {
      // Long format: keep the latest year that has a value.
      if ((value !== null && (prev.value === null || year > prev.year)) || (prev.value === null && value === null && year > prev.year)) {
        Object.assign(prev, { value, year, sourceName: label });
        if (flag) prev.flag = flag; else delete prev.flag;
      }
      continue;
    }
    // Same entity twice for the same year: identical values are deduped, conflicting values are an error.
    if (prev.value !== value) {
      throw new Error(`${specPath}: conflicting values for ${m.key} (${[...prev.names].join(' / ')}): ${prev.value} vs ${value}`);
    }
    if (!duplicates.has(m.key)) duplicates.set(m.key, prev.names);
  }

  if (unmatched.length && spec.strict !== false) throw new UnmatchedError([...new Set(unmatched)], specPath);
  for (const u of new Set(unmatched)) skipped.push({ name: u, reason: 'UNMATCHED (strict=false)' });

  const outRows: DatasetRow[] = [...best.values()]
    .map(({ names: _n, ...row }) => row)
    .sort((a, b) => a.key.localeCompare(b.key));

  let outSeries: DatasetSeries | undefined;
  if (spec.keepSeries) {
    const years = [...series.values()].flatMap((s) => [...s.keys()]);
    const start = Math.min(...years), end = Math.max(...years);
    const values: DatasetSeries['values'] = {};
    const flags: NonNullable<DatasetSeries['flags']> = {};
    for (const key of [...series.keys()].sort()) {
      const s = series.get(key)!;
      const arr: (number | null)[] = [];
      for (let y = start; y <= end; y++) arr.push(s.get(y)?.value ?? null);
      if (arr.every((v) => v === null)) continue; // nothing to plot; the row already records the entity as missing
      values[key] = arr;
      for (const [y, o] of s) if (o.flag && o.value !== null) (flags[key] ??= {})[String(y)] = o.flag;
    }
    outSeries = { start, end, values, ...(Object.keys(flags).length ? { flags } : {}) };
  }

  return {
    schemaVersion: 1,
    ...spec.dataset,
    import: {
      from: spec.input,
      spec: specPath,
      rowsRead,
      matched: outRows.length,
      missingValues: outRows.filter((r) => r.value === null).length,
      skipped,
      duplicates: [...duplicates].map(([key, names]) => ({ key, names: [...names] })),
      ...(spec.markerField ? { markers } : {}),
      ...(spec.minYear !== undefined ? { minYear: spec.minYear } : {}),
    },
    rows: outRows,
    ...(outSeries ? { series: outSeries } : {}),
  };
}
