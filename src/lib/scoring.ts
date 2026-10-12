import type { ScoringSpec, Dataset, CategoryDef } from './types';

export type Score = number | null;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Normalize raw indicator values to 0-100 where 100 = most dependent.
 * Missing (null / non-finite) values stay null. Never imputes.
 *  - fixed-range: 100 * clamp((v - lo) / (hi - lo), 0, 1)
 *  - minmax:      100 * (v - min) / (max - min) over entities with data
 *  - log-minmax:  minmax applied to log10(1 + v) (v must be >= 0)
 *  - percentile:  100 * (#below + 0.5 * (#equal - 1)) / (n - 1)  (mid-rank)
 * Then, if direction is lower_more_dependent, score = 100 - score.
 */
export function scoreValues(values: Map<string, number | null>, spec: ScoringSpec): Map<string, Score> {
  const out = new Map<string, Score>();
  const valid: [string, number][] = [];
  for (const [k, v] of values) {
    if (typeof v === 'number' && Number.isFinite(v)) valid.push([k, v]);
    else out.set(k, null);
  }
  let f: (v: number) => number;
  switch (spec.method) {
    case 'fixed-range': {
      if (!spec.range) throw new Error('fixed-range scoring requires range');
      const [lo, hi] = spec.range;
      if (hi === lo) throw new Error('fixed-range scoring requires distinct range bounds');
      f = (v) => 100 * clamp01((v - lo) / (hi - lo));
      break;
    }
    case 'minmax':
    case 'log-minmax': {
      const tx = spec.method === 'log-minmax' ? (v: number) => Math.log10(1 + Math.max(0, v)) : (v: number) => v;
      const xs = valid.map(([, v]) => tx(v));
      const min = Math.min(...xs);
      const max = Math.max(...xs);
      f = (v) => (max === min ? 50 : (100 * (tx(v) - min)) / (max - min));
      break;
    }
    case 'percentile': {
      const sorted = valid.map(([, v]) => v).sort((a, b) => a - b);
      const n = sorted.length;
      f = (v) => {
        if (n <= 1) return 50;
        let below = 0, equal = 0;
        for (const x of sorted) { if (x < v) below++; else if (x === v) equal++; }
        return (100 * (below + 0.5 * (equal - 1))) / (n - 1);
      };
      break;
    }
    default:
      throw new Error(`Unknown scoring method: ${(spec as ScoringSpec).method}`);
  }
  for (const [k, v] of valid) {
    let s = f(v);
    if (spec.direction === 'lower_more_dependent') s = 100 - s;
    out.set(k, s);
  }
  return out;
}

/** Human-readable formula for an indicator's 0-100 score. */
export function describeScoring(spec: ScoringSpec, unit: string): string {
  const inv = spec.direction === 'lower_more_dependent';
  let base: string;
  switch (spec.method) {
    case 'fixed-range':
      base = `100 × clamp((value − ${spec.range?.[0]}) / (${spec.range?.[1]} − ${spec.range?.[0]}), 0, 1)`;
      break;
    case 'minmax':
      base = '100 × (value − min) / (max − min), across all entities with data';
      break;
    case 'log-minmax':
      base = '100 × (log10(1+value) − min) / (max − min) of log10(1+value), across all entities with data';
      break;
    case 'percentile':
      base = '100 × percentile rank of value among all entities with data (mid-rank for ties)';
      break;
  }
  return `${inv ? '100 − [' + base + ']' : base}; value in ${unit}`;
}

export interface IndicatorScores {
  dataset: Dataset;
  raw: Map<string, number | null>;
  score: Map<string, Score>;
}

export function scoreDataset(ds: Dataset): IndicatorScores {
  const raw = new Map<string, number | null>();
  for (const r of ds.rows) raw.set(r.key, r.value);
  return { dataset: ds, raw, score: scoreValues(raw, ds.scoring) };
}

/** Category score = weighted mean of included indicator scores that exist for this entity; null if none. */
export function categoryScore(key: string, indicators: IndicatorScores[]): Score {
  let sw = 0, s = 0;
  for (const ind of indicators) {
    if (!ind.dataset.scoring.include) continue;
    const v = ind.score.get(key);
    if (v == null) continue;
    const w = ind.dataset.scoring.weight ?? 1;
    if (w <= 0) continue;
    sw += w; s += w * v;
  }
  return sw > 0 ? s / sw : null;
}

export interface CompositeResult {
  /** 0-100 dependence (100 = most dependent); null when no weighted category has data. */
  dependence: Score;
  /** 100 - dependence. */
  selfSufficiency: Score;
  used: string[];
  missing: string[];
}

/**
 * Composite dependence = Σ(w_c × s_c) / Σ(w_c), over categories c with a score and w_c > 0.
 * Categories with no data are listed in `missing` and excluded (not treated as 0).
 */
export function composite(catScores: Record<string, Score>, weights: Record<string, number>): CompositeResult {
  let sw = 0, s = 0;
  const used: string[] = [], missing: string[] = [];
  for (const [c, w] of Object.entries(weights)) {
    if (!(w > 0)) continue;
    const v = catScores[c];
    if (v == null) { missing.push(c); continue; }
    sw += w; s += w * v; used.push(c);
  }
  const dependence = sw > 0 ? s / sw : null;
  return { dependence, selfSufficiency: dependence == null ? null : 100 - dependence, used, missing };
}

/** Group scored indicators by category id. */
export function byCategory(cats: CategoryDef[], inds: IndicatorScores[]): Record<string, IndicatorScores[]> {
  const out: Record<string, IndicatorScores[]> = {};
  for (const c of cats) out[c.id] = [];
  for (const i of inds) (out[i.dataset.category] ??= []).push(i);
  return out;
}

/** 'scored' if any included indicator, 'context' if only context indicators, else 'needed'. */
export function categoryStatus(inds: IndicatorScores[] | undefined): 'scored' | 'context' | 'needed' {
  if (!inds || inds.length === 0) return 'needed';
  return inds.some((i) => i.dataset.scoring.include) ? 'scored' : 'context';
}
