import type { Dataset, DatasetMeta, DatasetRow, DatasetSeries } from './types';

/**
 * Derived datasets are computed from other normalized datasets' full annual series, never from guesses.
 * Spec file: data/sources/<id>.derived.json.
 *  - net:        imports − exports                       (same unit required)
 *  - net-share:  100 × (imports − exports) ÷ base        (all three in the same unit; base must be > 0)
 * For each entity the latest year in which every input has a numeric value is used. Entities listed by an input
 * but with no common year are kept as explicitly missing.
 */
export interface DerivedSpec {
  derive:
    | { op: 'net'; imports: string; exports: string }
    | { op: 'net-share'; imports: string; exports: string; base: string };
  dataset: DatasetMeta;
}

/** Trim float noise from subtraction (e.g. 0.1 − 0.3) without changing meaningful digits. */
const tidy = (x: number) => Number(x.toPrecision(12));

export function deriveDataset(spec: DerivedSpec, inputs: Map<string, Dataset>, specPath = 'derived'): Dataset {
  const d = spec.derive;
  const ids = d.op === 'net' ? [d.imports, d.exports] : [d.imports, d.exports, d.base];
  const ds = ids.map((id) => {
    const x = inputs.get(id);
    if (!x) throw new Error(`${specPath}: input dataset "${id}" not found`);
    if (!x.series) throw new Error(`${specPath}: input "${id}" has no series (set keepSeries in its source spec)`);
    return x;
  });
  const units = new Set(ds.map((x) => x.indicator.unit));
  if (units.size !== 1) throw new Error(`${specPath}: inputs have different units (${[...units].join(', ')}); refusing to combine`);
  const unit = [...units][0];
  if (d.op === 'net' && spec.dataset.indicator.unit !== unit) {
    throw new Error(`${specPath}: output unit "${spec.dataset.indicator.unit}" must equal the input unit "${unit}"`);
  }

  const start = Math.min(...ds.map((x) => x.series!.start));
  const end = Math.max(...ds.map((x) => x.series!.end));
  const at = (x: Dataset, key: string, year: number): number | null => {
    const s = x.series!;
    const arr = s.values[key];
    if (!arr || year < s.start || year > s.end) return null;
    return arr[year - s.start] ?? null;
  };
  const flagAt = (x: Dataset, key: string, year: number) => x.series!.flags?.[key]?.[String(year)];
  const compute = (key: string, year: number): number | null => {
    const v = ds.map((x) => at(x, key, year));
    if (v.some((n) => n === null)) return null;
    const net = (v[0] as number) - (v[1] as number);
    if (d.op === 'net') return tidy(net);
    const base = v[2] as number;
    return base > 0 ? tidy((100 * net) / base) : null;
  };

  const keys = new Set<string>();
  for (const x of ds) for (const r of x.rows) keys.add(r.key);
  const rows: DatasetRow[] = [];
  const values: DatasetSeries['values'] = {};
  const flags: NonNullable<DatasetSeries['flags']> = {};
  for (const key of [...keys].sort()) {
    const arr: (number | null)[] = [];
    for (let y = start; y <= end; y++) arr.push(compute(key, y));
    let year = -1;
    for (let y = end; y >= start; y--) if (arr[y - start] !== null) { year = y; break; }
    if (year === -1) { rows.push({ key, value: null, year: spec.dataset.year }); continue; }
    values[key] = arr;
    const yearFlags: Record<string, string> = {};
    for (let y = start; y <= end; y++) {
      if (arr[y - start] === null) continue;
      const f = [...new Set(ds.map((x) => flagAt(x, key, y)).filter(Boolean))].join(',');
      if (f) yearFlags[String(y)] = f;
    }
    if (Object.keys(yearFlags).length) flags[key] = yearFlags;
    const flag = yearFlags[String(year)];
    rows.push({ key, value: arr[year - start], year, ...(flag ? { flag } : {}) });
  }

  return {
    schemaVersion: 1,
    ...spec.dataset,
    import: {
      from: `derived: ${d.op}(${ids.join(', ')})`,
      spec: specPath,
      rowsRead: keys.size,
      matched: rows.length,
      missingValues: rows.filter((r) => r.value === null).length,
      skipped: [],
      duplicates: [],
    },
    rows,
    series: { start, end, values, ...(Object.keys(flags).length ? { flags } : {}) },
  };
}
