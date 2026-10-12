import type { Dataset, DatasetMeta, DatasetRow, DatasetSeries, ExposureBreakdown, ExposureEntry, ExposurePart } from './types';

/**
 * Derived datasets are computed from other normalized datasets' full annual series, never from guesses.
 * Spec file: data/sources/<id>.derived.json.
 *  - net:          imports − exports                         (same unit required)
 *  - net-share:    100 × (imports − exports) ÷ base          (all three in the same unit; base must be > 0)
 *  - dependence:   100 × (supply − production) ÷ supply      (same unit; supply must be > 0). Net import dependence of a
 *                  fuel; negative = net exporter. Not clamped here.
 *  - electricity-exposure: share of electricity supply that depends on imports, directly (net electricity imports) or
 *                  through imported fuel burned in power plants. See electricityExposure() and the Method page.
 * For each entity the latest year in which every input has a numeric value is used (no mixing years). Entities listed by
 * an input but with no common year are kept as explicitly missing.
 */
export interface ExposureFuel {
  /** Part id, e.g. "coal". */
  id: string;
  label: string;
  /** Dataset id: electricity generated from this fuel (same unit as generation). */
  generation: string;
  /** Dataset id: the fuel's national net-import dependence in % (op "dependence"). */
  dependence: string;
}

export type DeriveOp =
  | { op: 'net'; imports: string; exports: string }
  | { op: 'net-share'; imports: string; exports: string; base: string }
  | { op: 'dependence'; supply: string; production: string }
  | {
      op: 'electricity-exposure'; generation: string; netImports: string; fuels: ExposureFuel[];
      /** The latest exact value is only used if it is at most this many years older than the latest year with
       * generation and trade data (otherwise the value is missing and only the newer bounds are shown). */
      maxLagYears?: number;
    };

export interface DerivedSpec {
  derive: DeriveOp;
  dataset: DatasetMeta;
}

/** Input dataset ids of a derived spec, in the order the op uses them. */
export function deriveInputs(d: DeriveOp): string[] {
  switch (d.op) {
    case 'net': return [d.imports, d.exports];
    case 'net-share': return [d.imports, d.exports, d.base];
    case 'dependence': return [d.supply, d.production];
    case 'electricity-exposure': return [d.generation, d.netImports, ...d.fuels.flatMap((f) => [f.generation, f.dependence])];
  }
}

/** Trim float noise from subtraction (e.g. 0.1 − 0.3) without changing meaningful digits. */
const tidy = (x: number) => Number(x.toPrecision(12));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Electricity import exposure for one entity-year, all energy inputs in the same unit (e.g. TWh):
 *   S        = G + max(N, 0)                       electricity supply before exports (G generation, N net imports)
 *   direct   = max(N, 0) ÷ S
 *   fuel f   = g_f ÷ S × clamp(dep_f ÷ 100, 0, 1)  g_f generation from fuel f, dep_f its net-import dependence (%)
 *   exposure = 100 × (direct + Σ_f fuel f)
 * A fuel with g_f = 0 contributes exactly 0 whether or not its dependence is known. If g_f > 0 and dep_f is missing,
 * the exposure is not computed; only bounds are returned (dep_f = 0 % → low, 100 % → high).
 * Returns null when G, N or any g_f is missing, or S ≤ 0.
 */
export function electricityExposure(
  G: number | null, N: number | null,
  fuels: { id: string; generation: number | null; dependence: number | null }[],
): Omit<ExposureEntry, 'year'> | null {
  if (G === null || N === null || fuels.some((f) => f.generation === null)) return null;
  const imp = Math.max(N, 0);
  const S = G + imp;
  if (!(S > 0)) return null;
  const direct = imp / S;
  let known = 0, unknown = 0, exact = true;
  const parts: Record<string, ExposurePart> = {};
  for (const f of fuels) {
    const share = (f.generation as number) / S;
    const dep = f.dependence === null ? null : clamp01(f.dependence / 100);
    let contribution: number | null;
    if (f.generation === 0) contribution = 0;
    else if (dep === null) { contribution = null; unknown += share; exact = false; }
    else contribution = share * dep;
    if (contribution !== null) known += contribution;
    parts[f.id] = { share: tidy(100 * share), dependence: dep === null ? null : tidy(100 * dep), contribution: contribution === null ? null : tidy(100 * contribution) };
  }
  const low = tidy(100 * (direct + known));
  return { exact, direct: tidy(100 * direct), parts, low, high: exact ? low : tidy(100 * (direct + known + unknown)) };
}

export function deriveDataset(spec: DerivedSpec, inputs: Map<string, Dataset>, specPath = 'derived'): Dataset {
  const d = spec.derive;
  const ids = deriveInputs(d);
  const get = (id: string) => {
    const x = inputs.get(id);
    if (!x) throw new Error(specPath + ': input dataset "' + id + '" not found');
    if (!x.series) throw new Error(specPath + ': input "' + id + '" has no series (set keepSeries in its source spec)');
    return x;
  };
  const ds = ids.map(get);
  const unitOf = (id: string) => get(id).indicator.unit;

  if (d.op === 'electricity-exposure') {
    const energyIds = [d.generation, d.netImports, ...d.fuels.map((f) => f.generation)];
    const units = new Set(energyIds.map(unitOf));
    if (units.size !== 1) throw new Error(specPath + ': electricity inputs have different units (' + [...units].join(', ') + '); refusing to combine');
    for (const f of d.fuels) {
      if (!unitOf(f.dependence).startsWith('%')) throw new Error(specPath + ': dependence input "' + f.dependence + '" must be a % (has "' + unitOf(f.dependence) + '")');
    }
  } else {
    const units = new Set(ds.map((x) => x.indicator.unit));
    if (units.size !== 1) throw new Error(specPath + ': inputs have different units (' + [...units].join(', ') + '); refusing to combine');
    const unit = [...units][0];
    if (d.op === 'net' && spec.dataset.indicator.unit !== unit) {
      throw new Error(specPath + ': output unit "' + spec.dataset.indicator.unit + '" must equal the input unit "' + unit + '"');
    }
  }

  const start = Math.min(...ds.map((x) => x.series!.start));
  const end = Math.max(...ds.map((x) => x.series!.end));
  const at = (x: Dataset, key: string, year: number): number | null => {
    const s = x.series!;
    const arr = s.values[key];
    if (!arr || year < s.start || year > s.end) return null;
    return arr[year - s.start] ?? null;
  };
  const atId = (id: string, key: string, year: number) => at(get(id), key, year);
  const flagAt = (x: Dataset, key: string, year: number) => x.series!.flags?.[key]?.[String(year)];

  const exposureAt = (key: string, year: number) => {
    if (d.op !== 'electricity-exposure') return null;
    return electricityExposure(atId(d.generation, key, year), atId(d.netImports, key, year),
      d.fuels.map((f) => ({ id: f.id, generation: atId(f.generation, key, year), dependence: atId(f.dependence, key, year) })));
  };

  const compute = (key: string, year: number): number | null => {
    if (d.op === 'electricity-exposure') {
      const e = exposureAt(key, year);
      return e && e.exact ? e.low : null;
    }
    const v = ds.map((x) => at(x, key, year));
    if (v.some((n) => n === null)) return null;
    if (d.op === 'dependence') {
      const supply = v[0] as number;
      return supply > 0 ? tidy((100 * (supply - (v[1] as number))) / supply) : null;
    }
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
  const byKey: ExposureBreakdown['byKey'] = {};
  for (const key of [...keys].sort()) {
    const arr: (number | null)[] = [];
    for (let y = start; y <= end; y++) arr.push(compute(key, y));
    let year = -1;
    for (let y = end; y >= start; y--) if (arr[y - start] !== null) { year = y; break; }
    if (d.op === 'electricity-exposure') {
      // Latest year with generation and trade data (bounds computable).
      let latest = -1;
      for (let y = end; y >= start; y--) if (exposureAt(key, y)) { latest = y; break; }
      // A stale exact value (much older than the latest data) is not used; the newer bounds are shown instead.
      if (year !== -1 && d.maxLagYears !== undefined && latest - year > d.maxLagYears) year = -1;
      // Breakdown at the value's year; with no (recent) exact value, at the latest year with bounds.
      const by = year !== -1 ? year : latest;
      const e = by === -1 ? null : exposureAt(key, by);
      if (e) byKey[key] = { year: by, ...e };
    }
    if (year === -1) {
      rows.push({ key, value: null, year: spec.dataset.year });
      if (arr.some((v) => v !== null)) values[key] = arr; // older exact values stay in the series (trend chart)
      continue;
    }
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
      from: 'derived: ' + d.op + '(' + ids.join(', ') + ')',
      spec: specPath,
      rowsRead: keys.size,
      matched: rows.length,
      missingValues: rows.filter((r) => r.value === null).length,
      skipped: [],
      duplicates: [],
    },
    rows,
    series: { start, end, values, ...(Object.keys(flags).length ? { flags } : {}) },
    ...(d.op === 'electricity-exposure' ? { breakdown: { parts: d.fuels.map((f) => ({ id: f.id, label: f.label })), byKey } } : {}),
  };
}
