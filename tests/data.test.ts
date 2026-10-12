/** Integration tests over the real repo data: committed datasets must match a fresh import of data/raw. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { normalize, readRows, type SourceSpec } from '../src/lib/importer';
import { buildModel, compositeFor } from '../src/app/model';
import type { CategoryDef, Dataset, Entity } from '../src/lib/types';

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const entities: Entity[] = json('data/reference/entities.json');
const aliases = json('data/reference/aliases.json');
const categories: CategoryDef[] = json('data/categories.json');
const specFiles = readdirSync('data/sources').filter((f) => f.endsWith('.source.json'));
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

describe('model over real data', () => {
  const m = buildModel(entities, categories, datasets);
  it('categories without datasets are marked data needed and score null', () => {
    for (const id of ['energy', 'medicine', 'minerals', 'manufactured', 'water']) {
      expect(m.status[id]).toBe('needed');
      expect(m.catScores.get('USA')?.[id]).toBeNull();
    }
    expect(m.status.food).toBe('context');
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
