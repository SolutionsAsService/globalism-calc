/** Integration tests over the real repo data: committed datasets must match a fresh import of data/raw. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalize, readRows, type SourceSpec } from '../src/lib/importer';
import { deriveDataset, type DerivedSpec } from '../src/lib/derive';
import { buildModel, compositeFor } from '../src/app/model';
import type { CategoryDef, Dataset, Entity } from '../src/lib/types';

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const entities: Entity[] = json('data/reference/entities.json');
const aliases = json('data/reference/aliases.json');
const categories: CategoryDef[] = json('data/categories.json');
const specFiles = readdirSync('data/sources').filter((f) => f.endsWith('.source.json'));
const derivedFiles = readdirSync('data/sources').filter((f) => f.endsWith('.derived.json'));
const datasets: Dataset[] = readdirSync('data/datasets').filter((f) => f.endsWith('.json')).map((f) => json(`data/datasets/${f}`));

describe('reference data', () => {
  it('entity keys are unique and follow the key scheme', () => {
    const keys = entities.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of entities) {
      if (e.type === 'subnational') expect(e.key).toMatch(/^[A-Z]{3}-[A-Z0-9]{1,3}$/);
      else expect(e.key).toMatch(/^[A-Z]{3}$/);
      if (e.parent) expect(keys).toContain(e.parent);
    }
  });
  it('categories are unique and include the planned ones', () => {
    const ids = categories.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['food', 'energy', 'medicine', 'minerals', 'manufactured', 'water']) expect(ids).toContain(id);
  });
});

describe('datasets', () => {
  it('every source spec imports cleanly and matches the committed dataset (run npm run data:import if this fails)', () => {
    expect(specFiles.length).toBeGreaterThan(0);
    for (const f of specFiles) {
      const spec: SourceSpec = json(`data/sources/${f}`);
      const fresh = normalize(spec, readRows(spec, readFileSync(spec.input, 'utf8')), entities, aliases, `data/sources/${f}`);
      expect(json(`data/datasets/${fresh.id}.json`)).toEqual(JSON.parse(JSON.stringify(fresh)));
    }
  });
  it('every derived spec matches the committed dataset when recomputed from the committed inputs', () => {
    expect(derivedFiles.length).toBeGreaterThan(0);
    const byId = new Map(datasets.map((d) => [d.id, d]));
    for (const f of derivedFiles) {
      const spec: DerivedSpec = json(`data/sources/${f}`);
      const fresh = deriveDataset(spec, byId, `data/sources/${f}`);
      expect(json(`data/datasets/${fresh.id}.json`)).toEqual(JSON.parse(JSON.stringify(fresh)));
    }
  });
  it('every dataset has complete metadata, a known category and valid rows', () => {
    const keys = new Set(entities.map((e) => e.key));
    for (const d of datasets) {
      for (const k of ['id', 'title', 'category', 'year'] as const) expect(d[k], `${d.id}.${k}`).toBeTruthy();
      expect(d.indicator.name && d.indicator.unit).toBeTruthy();
      expect(d.source.name && d.source.url && d.source.license).toBeTruthy();
      expect(categories.map((c) => c.id)).toContain(d.category);
      for (const r of d.rows) {
        expect(keys.has(r.key), r.key).toBe(true);
        expect(r.value === null || Number.isFinite(r.value)).toBe(true);
      }
    }
  });
  it('known values survive the import exactly (no invented numbers)', () => {
    const trade = datasets.find((d) => d.id === 'wb-trade-pct-gdp-2022')!;
    const get = (d: Dataset, k: string) => d.rows.find((r) => r.key === k);
    expect(get(trade, 'ABW')?.value).toBe(169.7982829);
    expect(get(trade, 'AND')?.value).toBeNull(); // null in source -> explicitly missing
    expect(get(trade, 'USA')).toBeDefined();
    expect(trade.rows.some((r) => r.sourceName === 'World')).toBe(false); // aggregates skipped
    const food = datasets.find((d) => d.id === 'wits-world-food-imports-by-partner-2022')!;
    expect(get(food, 'USA')?.value).toBe(57727386740);
    expect(get(food, 'AIA')?.sourceName).toBe('Anguila');
    expect(food.scoring.include).toBe(false);
  });
});

describe('EIA energy datasets', () => {
  const eiaSpecs = specFiles.map((f) => json(`data/sources/${f}`) as SourceSpec).filter((s) => s.format === 'eia-series');
  type RawSeries = { iso: string; unit: string; productid: string; activityid: string; data: { date: number; value: string }[] };
  const rawOf = (s: SourceSpec) => (json(s.input) as RawSeries[]).filter((x) => x.productid === s.where!.productid && x.activityid === s.where!.activityid);
  const byId = (id: string) => datasets.find((d) => d.id === id)!;
  const row = (id: string, k: string) => byId(id).rows.find((r) => r.key === k);

  it('covers all ten EIA series and leaves the raw exports in data/raw/eia', () => {
    expect(eiaSpecs.map((s) => s.dataset.id).sort()).toEqual([
      'eia-coal-imports', 'eia-crude-oil-exports', 'eia-crude-oil-imports', 'eia-electricity-exports', 'eia-electricity-imports',
      'eia-electricity-net-consumption', 'eia-lpg-ethane-exports', 'eia-lpg-ethane-imports', 'eia-natural-gas-exports', 'eia-natural-gas-imports',
    ]);
    for (const s of eiaSpecs) expect(s.input.startsWith('data/raw/eia/')).toBe(true);
    expect(readdirSync('data/datasets').some((f) => f.includes('SeriesExport'))).toBe(false);
  });

  it('the unnamed export is a byte-identical copy of the natural gas imports export and is not imported twice', () => {
    const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    expect(sha('data/raw/eia/SeriesExport-10-12-2026-18-12-18.json')).toBe(sha('data/raw/eia/nat-gas-import-SeriesExport-10-12-2026-18-14-20.json'));
    expect(eiaSpecs.some((s) => s.input.endsWith('/SeriesExport-10-12-2026-18-12-18.json'))).toBe(false);
  });

  it('declared units are exactly the units stated in every raw series', () => {
    for (const s of eiaSpecs) for (const x of rawOf(s)) expect(x.unit, `${s.dataset.id} ${x.iso}`).toBe(s.dataset.indicator.unit);
  });

  it('every row is the latest numeric raw value for that ISO code (checked independently of the importer)', () => {
    const alias: Record<string, string> = { XKS: 'XKX' };
    for (const s of eiaSpecs) {
      const ds = byId(s.dataset.id);
      for (const x of rawOf(s)) {
        const key = alias[x.iso] ?? x.iso;
        const r = ds.rows.find((y) => y.key === key);
        if (!r) { expect(ds.import.skipped.map((k) => k.name), `${s.dataset.id} ${x.iso}`).toContain(x.iso); continue; }
        const nums = x.data.map((d) => ({ y: new Date(d.date).getUTCFullYear(), m: /^(?:([a-z]+)\|)?(-?[\d.]+(?:e[-+]?\d+)?)$/i.exec(String(d.value)) })).filter((d) => d.m);
        const last = nums[nums.length - 1];
        if (!last) { expect(r.value, `${s.dataset.id} ${key}`).toBeNull(); continue; }
        expect([r.value, r.year, r.flag], `${s.dataset.id} ${key}`).toEqual([Number(last.m![2]), last.y, last.m![1]]);
      }
    }
  });

  it('known values (spot checks against the raw exports)', () => {
    expect(row('eia-crude-oil-imports', 'USA')).toMatchObject({ value: 5876.525, year: 2020 });
    expect(row('eia-natural-gas-imports', 'DEU')).toMatchObject({ value: 2622.367559, year: 2024 });
    expect(row('eia-natural-gas-net-imports', 'USA')).toMatchObject({ value: -4562.200312, year: 2024 }); // 3144.844499 − 7707.044811
    expect(row('eia-electricity-imports', 'XKX')).toBeDefined(); // EIA code XKS
    expect(byId('eia-coal-imports').rows.some((r) => r.key === 'WORL' || r.key === 'SUN')).toBe(false);
    // "ie" (included elsewhere) for Guadeloupe from 2011 is missing, never 0: the latest value is from before 2011.
    expect(row('eia-electricity-net-consumption', 'GLP')!.year).toBeLessThan(2011);
  });

  it('electricity net-import share = 100 × (imports − exports) ÷ net consumption for the same year', () => {
    const at = (id: string, k: string, y: number) => { const s = byId(id).series!; return s.values[k][y - s.start]!; };
    for (const k of ['LUX', 'DEU', 'ITA', 'USA', 'PRY']) {
      const r = row('eia-electricity-net-import-share', k)!;
      const expected = (100 * (at('eia-electricity-imports', k, r.year) - at('eia-electricity-exports', k, r.year))) / at('eia-electricity-net-consumption', k, r.year);
      expect(r.value).toBeCloseTo(expected, 8);
    }
    expect(row('eia-electricity-net-import-share', 'LUX')!.value).toBeGreaterThan(50);
    expect(row('eia-electricity-net-import-share', 'PRY')!.value).toBeLessThan(0); // net exporter
  });
});

describe('model over real data', () => {
  const m = buildModel(entities, categories, datasets);
  it('categories without datasets are marked data needed and score null', () => {
    for (const id of ['medicine', 'minerals', 'manufactured', 'water']) {
      expect(m.status[id]).toBe('needed');
      expect(m.catScores.get('USA')?.[id]).toBeNull();
    }
    expect(m.status.food).toBe('context');
    expect(m.status.energy).toBe('context'); // EIA flows are shown but not scored
    expect(m.catScores.get('USA')?.energy).toBeNull();
    expect(m.status.trade).toBe('scored');
  });
  it('composite only uses categories with data, within 0..100', () => {
    const w = Object.fromEntries(categories.map((c) => [c.id, c.defaultWeight]));
    const r = compositeFor(m, 'USA', w);
    expect(r.used).toEqual(['trade']);
    expect(r.dependence).toBe(m.catScores.get('USA')!.trade);
    expect(compositeFor(m, 'AND', w).dependence).toBeNull();
    for (const e of entities) {
      const d = compositeFor(m, e.key, w).dependence;
      if (d != null) expect(d >= 0 && d <= 100).toBe(true);
    }
  });
});
