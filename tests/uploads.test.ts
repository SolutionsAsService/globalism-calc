import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { autoSpec, isNormalized } from '../src/lib/uploads';
import { buildModel, rebuild } from '../src/app/model';
import type { Dataset } from '../src/lib/types';

const up = (f: string) => JSON.parse(readFileSync('data/raw/uploads/' + f, 'utf8'));

describe('uploaded tables', () => {
  it('raw uploads are never published as datasets', () => {
    for (const f of readdirSync('data/datasets').filter((f) => f.endsWith('.json'))) expect(isNormalized(JSON.parse(readFileSync('data/datasets/' + f, 'utf8')))).toBe(true);
    for (const f of readdirSync('data/raw/uploads').filter((f) => f.endsWith('.json'))) expect(isNormalized(up(f))).toBe(false);
  });
  it('World Bank "most recent value" tables get a spec; exports are context; unknown shapes do not', () => {
    const food = autoSpec('x.json', up('world_bank_food_imports_share_2025_latest.json'))!;
    expect(food.dataset).toMatchObject({ id: 'wb-tm-val-food-zs-un', category: 'food', scoring: { include: true, method: 'percentile' } });
    expect(food.minYear).toBe(2010);
    expect(autoSpec('x.json', up('world_bank_ores_and_metals_exports_share_2025_latest.json'))!.dataset.scoring.include).toBe(false);
    expect(autoSpec('x.json', up('world_bank_manufactures_imports_share_2025_latest.json'))!.dataset.category).toBe('manufactured');
    expect(autoSpec('x.json', up('global_pharmaceutical_trade_2024.json'))).toBeNull();
    expect(autoSpec('x.json', { entities: [{ entity_name: 'A', most_recent_value_percent: 1 }], indicator: { code: 'XX.UNKNOWN' } })).toBeNull();
  });
  it('generated datasets keep blank cells missing and drop pre-2010 values', () => {
    const ds: Dataset = JSON.parse(readFileSync('data/datasets/wb-tm-val-food-zs-un.json', 'utf8'));
    expect(ds.rows.filter((r) => r.value === null).length).toBeGreaterThan(0);
    expect(ds.rows.every((r) => r.value === null || r.year >= 2010)).toBe(true);
    expect(ds.rows.some((r) => r.key === 'SOM')).toBe(false); // Somalia's latest value is from 1982
  });
  it('pharma net-import share = 100 × (imports − exports) ÷ imports', () => {
    const get = (id: string) => new Map((JSON.parse(readFileSync('data/datasets/' + id + '.json', 'utf8')) as Dataset).rows.map((r) => [r.key, r.value]));
    const imp = get('itc-pharma-imports-2024'), exp = get('itc-pharma-exports-2024'), net = get('itc-pharma-net-import-share-2024');
    for (const k of ['USA', 'DEU', 'IND', 'NGA']) expect(net.get(k)).toBeCloseTo((100 * (imp.get(k)! - exp.get(k)!)) / imp.get(k)!, 6);
    expect(net.get('IND')!).toBeLessThan(0); // net exporter
  });
});

describe('dataset overrides', () => {
  const ds = (id: string, cat: string, vals: number[], include = true): Dataset => ({
    schemaVersion: 1, id, title: id, category: cat, indicator: { name: id, unit: '%' }, source: { name: 's', url: 'u', license: 'l' }, year: 2024,
    scoring: { include, direction: 'higher_more_dependent', method: 'fixed-range', range: [0, 100] },
    import: { from: 'x', spec: 'y', rowsRead: 2, matched: 2, skipped: [] }, rows: vals.map((v, i) => ({ key: 'K' + i, value: v, year: 2024 })),
  } as unknown as Dataset);
  const ents = [{ key: 'K0', name: 'A', type: 'country' }, { key: 'K1', name: 'B', type: 'country' }] as any;
  const cats = [{ id: 'food', label: 'Food', defaultWeight: 1 }] as any;
  const m = buildModel(ents, cats, [ds('a', 'food', [20, 40]), ds('b', 'food', [80, 100], false)]);
  it('switching a context dataset on and re-weighting changes the category score', () => {
    expect(m.catScores.get('K0')!.food).toBe(20);
    const on = rebuild(m, { b: { include: true } });
    expect(on.catScores.get('K0')!.food).toBe(50);
    expect(rebuild(m, { b: { include: true, weight: 3 } }).catScores.get('K0')!.food).toBe(65);
    expect(rebuild(m, { a: { include: false } }).status.food).toBe('context');
    expect(m.datasets[1].scoring.include).toBe(false); // originals untouched
  });
});
