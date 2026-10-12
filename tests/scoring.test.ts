import { describe, it, expect } from 'vitest';
import { scoreValues, categoryScore, composite, describeScoring, scoreDataset } from '../src/lib/scoring';
import type { Dataset, ScoringSpec } from '../src/lib/types';

const vals = (o: Record<string, number | null>) => new Map(Object.entries(o));
const spec = (s: Partial<ScoringSpec>): ScoringSpec => ({ include: true, direction: 'higher_more_dependent', method: 'minmax', ...s });

describe('scoreValues', () => {
  it('minmax maps min->0, max->100 and keeps missing as null', () => {
    const s = scoreValues(vals({ A: 10, B: 20, C: 30, D: null }), spec({ method: 'minmax' }));
    expect(s.get('A')).toBe(0);
    expect(s.get('B')).toBe(50);
    expect(s.get('C')).toBe(100);
    expect(s.get('D')).toBeNull();
  });

  it('lower_more_dependent inverts the score', () => {
    const s = scoreValues(vals({ A: 10, B: 30 }), spec({ method: 'minmax', direction: 'lower_more_dependent' }));
    expect(s.get('A')).toBe(100);
    expect(s.get('B')).toBe(0);
  });

  it('fixed-range clamps to 0..100 (e.g. net energy imports % of use; exporters are negative)', () => {
    const s = scoreValues(vals({ EXP: -250, HALF: 50, ALL: 100, OVER: 130 }), spec({ method: 'fixed-range', range: [0, 100] }));
    expect([s.get('EXP'), s.get('HALF'), s.get('ALL'), s.get('OVER')]).toEqual([0, 50, 100, 100]);
  });

  it('fixed-range requires a valid range', () => {
    expect(() => scoreValues(vals({ A: 1 }), spec({ method: 'fixed-range' }))).toThrow();
    expect(() => scoreValues(vals({ A: 1 }), spec({ method: 'fixed-range', range: [5, 5] }))).toThrow();
  });

  it('percentile uses mid-rank for ties', () => {
    const s = scoreValues(vals({ A: 1, B: 2, C: 2, D: 3 }), spec({ method: 'percentile' }));
    expect(s.get('A')).toBe(0);
    expect(s.get('B')).toBeCloseTo(50);
    expect(s.get('C')).toBeCloseTo(50);
    expect(s.get('D')).toBe(100);
  });

  it('log-minmax compresses large ranges', () => {
    const s = scoreValues(vals({ A: 9, B: 99, C: 999 }), spec({ method: 'log-minmax' }));
    expect(s.get('A')).toBe(0);
    expect(s.get('B')).toBeCloseTo(50);
    expect(s.get('C')).toBe(100);
  });

  it('degenerate inputs: single value / all equal -> 50, no values -> nothing scored', () => {
    expect(scoreValues(vals({ A: 5 }), spec({ method: 'percentile' })).get('A')).toBe(50);
    expect(scoreValues(vals({ A: 5, B: 5 }), spec({ method: 'minmax' })).get('B')).toBe(50);
    expect([...scoreValues(vals({ A: null }), spec({})).values()]).toEqual([null]);
  });

  it('describes formulas in plain text', () => {
    expect(describeScoring(spec({ method: 'percentile' }), '% of GDP')).toMatch(/percentile rank/);
    expect(describeScoring(spec({ method: 'fixed-range', range: [0, 100], direction: 'lower_more_dependent' }), '%')).toMatch(/^100 − \[/);
  });
});

function ds(id: string, category: string, rows: Record<string, number | null>, s: Partial<ScoringSpec> = {}): Dataset {
  return {
    schemaVersion: 1, id, title: id, category, year: 2022,
    indicator: { name: id, unit: 'u' }, source: { name: 's', url: 'u', license: 'l' },
    scoring: spec(s),
    import: { from: '', spec: '', rowsRead: 0, matched: 0, missingValues: 0, skipped: [], duplicates: [] },
    rows: Object.entries(rows).map(([key, value]) => ({ key, value, year: 2022 })),
  };
}

describe('categoryScore', () => {
  it('weighted mean of included indicators that have data; context-only indicators ignored', () => {
    const a = scoreDataset(ds('a', 'food', { X: 0, Y: 100 }, { weight: 3 }));
    const b = scoreDataset(ds('b', 'food', { X: 100, Y: 0 }, { weight: 1 }));
    const ctx = scoreDataset(ds('c', 'food', { X: 0, Y: 100 }, { include: false }));
    expect(categoryScore('X', [a, b, ctx])).toBe(25); // (3*0 + 1*100) / 4
    expect(categoryScore('Y', [a, b, ctx])).toBe(75);
  });
  it('null when no included indicator has a value', () => {
    const a = scoreDataset(ds('a', 'food', { X: null, Y: 1 }));
    expect(categoryScore('X', [a])).toBeNull();
    expect(categoryScore('Z', [a])).toBeNull();
  });
});

describe('composite', () => {
  it('weights categories and excludes missing ones instead of treating them as 0', () => {
    const r = composite({ food: 80, energy: null, trade: 20 }, { food: 1, energy: 1, trade: 0.5 });
    expect(r.dependence).toBeCloseTo((80 * 1 + 20 * 0.5) / 1.5);
    expect(r.selfSufficiency).toBeCloseTo(100 - (80 + 10) / 1.5);
    expect(r.used).toEqual(['food', 'trade']);
    expect(r.missing).toEqual(['energy']);
  });
  it('zero weight removes a category', () => {
    expect(composite({ food: 80, trade: 20 }, { food: 0, trade: 1 }).dependence).toBe(20);
  });
  it('null when nothing is available', () => {
    const r = composite({ food: null }, { food: 1 });
    expect(r.dependence).toBeNull();
    expect(r.selfSufficiency).toBeNull();
  });
});
