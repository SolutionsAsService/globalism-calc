/** Integration tests over the real repo data: committed datasets must match a fresh import of data/raw. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalize, readRowsCached, type SourceSpec } from '../src/lib/importer';
import { deriveDataset, deriveInputs, type DerivedSpec } from '../src/lib/derive';
import { csvToObjects } from '../src/lib/csv';
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
      const fresh = normalize(spec, readRowsCached(spec, (p) => readFileSync(p, 'utf8')), entities, aliases, `data/sources/${f}`);
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
    expect(m.status.energy).toBe('scored'); // by the electricity import exposure; EIA flows stay context
    expect(m.status.trade).toBe('scored');
  });
  it('composite only uses categories with data, within 0..100', () => {
    const w = Object.fromEntries(categories.map((c) => [c.id, c.defaultWeight]));
    const r = compositeFor(m, 'USA', w);
    expect(r.used).toEqual(['energy', 'trade']);
    const c = m.catScores.get('USA')!;
    expect(r.dependence).toBeCloseTo((w.energy * c.energy! + w.trade * c.trade!) / (w.energy + w.trade), 10);
    // Energy weight 0 = back to trade only (the configurable switch in the UI).
    expect(compositeFor(m, 'USA', { ...w, energy: 0 }).dependence).toBe(c.trade);
    expect(compositeFor(m, 'AND', w).dependence).toBeNull();
    for (const e of entities) {
      const d = compositeFor(m, e.key, w).dependence;
      if (d != null) expect(d >= 0 && d <= 100).toBe(true);
    }
  });
});

describe('electricity: Ember + Energy Institute via Our World in Data', () => {
  const owidSpecs = specFiles.map((f) => json(`data/sources/${f}`) as SourceSpec).filter((s) => s.input.startsWith('data/raw/owid/'));
  const byId = (id: string) => datasets.find((d) => d.id === id)!;
  const row = (id: string, k: string) => byId(id).rows.find((r) => r.key === k);
  const at = (id: string, k: string, y: number) => { const s = byId(id).series!; const a = s.values[k]; return a ? a[y - s.start] ?? null : null; };
  const raw = csvToObjects(readFileSync('data/raw/owid/owid_energy.csv', 'utf8'));
  const rawAt = (iso: string, y: number, col: string) => { const r = raw.find((x) => x.iso_code === iso && x.year === String(y)); return r && r[col] !== '' ? Number(r[col]) : null; };
  const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

  it('raw OWID files are unchanged: SHA-256 matches the hash recorded in every spec and in PROVENANCE.md', () => {
    expect(owidSpecs.length).toBe(23);
    const prov = readFileSync('data/raw/owid/PROVENANCE.md', 'utf8');
    for (const f of ['owid_energy.csv', 'owid_energy.codebook.csv', 'owid_energy.sources.csv']) expect(prov).toContain(sha(`data/raw/owid/${f}`));
    for (const s of owidSpecs) {
      expect(s.dataset.source.sha256, s.dataset.id).toBe(sha(s.input));
      expect(s.dataset.source.retrieved).toBe('2026-10-12');
      expect(s.dataset.source.downloadUrl).toBe('https://catalog.ourworldindata.org/energy/owid_energy/owid_energy.csv');
    }
  });

  it('declared units match the OWID codebook unit of each column, and every column exists in the raw header', () => {
    const book = new Map(csvToObjects(readFileSync('data/raw/owid/owid_energy.codebook.csv', 'utf8')).map((r) => [r.column, r]));
    const header = Object.keys(raw[0]);
    for (const s of owidSpecs) {
      const b = book.get(s.valueField!);
      expect(b, s.valueField).toBeDefined();
      expect(header).toContain(s.valueField);
      expect(s.dataset.indicator.sourceUnit, s.dataset.id).toBe(b!.unit);
      expect(s.dataset.indicator.code).toBe(s.valueField);
      const expected = b!.unit === 'terawatt-hours (TWh)' ? 'TWh' : b!.unit === 'kilowatt-hours (kWh)' ? 'kWh per person' : b!.unit === '%' ? '%' : '?';
      expect(s.dataset.indicator.unit.startsWith(expected), `${s.dataset.id}: ${s.dataset.indicator.unit} vs ${b!.unit}`).toBe(true);
    }
  });

  it('every row is the latest raw value since 1990 for that ISO code (checked independently of the importer)', () => {
    for (const s of owidSpecs) {
      const ds = byId(s.dataset.id);
      const latest = new Map<string, { y: number; v: number }>();
      for (const r of raw) {
        if (!r.iso_code || Number(r.year) < 1990 || r[s.valueField!] === '') continue;
        const p = latest.get(r.iso_code);
        if (!p || Number(r.year) > p.y) latest.set(r.iso_code, { y: Number(r.year), v: Number(r[s.valueField!]) });
      }
      for (const [iso, { y, v }] of latest) {
        if (iso === 'ANT') { expect(ds.rows.some((r) => r.key === 'ANT')).toBe(false); continue; }
        expect(row(s.dataset.id, iso), `${s.dataset.id} ${iso}`).toMatchObject({ value: v, year: y });
      }
      for (const r of ds.rows) if (r.key !== 'XKX' && r.value !== null) expect(latest.has(r.key), `${s.dataset.id} ${r.key}`).toBe(true);
    }
  });

  it('blank cells stay missing (never 0); Kosovo is matched by name; aggregates are skipped', () => {
    expect(rawAt('LSO', 2024, 'gas_energy_twh')).toBeNull();
    expect(byId('owid-gas-supply').series!.values.LSO).toBeUndefined();
    expect(row('owid-gas-supply', 'LSO')!.value).toBeNull();
    expect(row('owid-electricity-generation', 'XKX')!.value).not.toBeNull();
    const skipped = byId('owid-electricity-generation').import.skipped.map((s) => s.name);
    for (const n of ['World', 'Europe (EI)', 'G20 (Ember)', 'USSR', 'ANT']) expect(skipped).toContain(n);
    expect(byId('owid-electricity-generation').import.minYear).toBe(1990);
    expect(byId('owid-electricity-generation').series!.start).toBe(1990);
  });

  it('internal consistency the exposure relies on: demand = generation + net imports, and the nine sources sum to generation', () => {
    const src = ['coal', 'gas', 'oil', 'nuclear', 'hydro', 'wind', 'solar', 'bioenergy', 'other-renewables'].map((s) => 'owid-electricity-' + s);
    const gen = byId('owid-electricity-generation').series!;
    let checkedDemand = 0, checkedMix = 0;
    for (const k of Object.keys(gen.values)) for (let y = gen.start; y <= gen.end; y++) {
      const G = at('owid-electricity-generation', k, y), D = at('owid-electricity-demand', k, y), N = at('owid-electricity-net-imports', k, y);
      if (G !== null && D !== null && N !== null) { expect(Math.abs(D - G - N), `${k} ${y}`).toBeLessThan(0.02); checkedDemand++; }
      const parts = src.map((id) => at(id, k, y));
      if (G !== null && parts.every((p) => p !== null)) { expect(Math.abs(G - (parts as number[]).reduce((a, b) => a + b, 0)), `${k} ${y}`).toBeLessThan(0.05 + 0.005 * G); checkedMix++; }
    }
    expect(checkedDemand).toBeGreaterThan(5000);
    expect(checkedMix).toBeGreaterThan(5000);
  });

  it('fuel net import dependence = 100 × (supply − production) ÷ supply from the raw file', () => {
    for (const [f, k] of [['gas', 'JPN'], ['coal', 'DEU'], ['oil', 'ITA'], ['gas', 'USA']] as const) {
      const r = row(`owid-${f}-net-import-dependence`, k)!;
      const s = rawAt(k, r.year, `${f}_energy_twh`)!, p = rawAt(k, r.year, `${f}_production_twh`)!;
      expect(r.value).toBeCloseTo((100 * (s - p)) / s, 8);
    }
    expect(row('owid-gas-net-import-dependence', 'USA')!.value).toBeLessThan(0); // net exporter
    expect(row('owid-gas-net-import-dependence', 'JPN')!.value).toBeGreaterThan(90);
  });

  it('import exposure: Japan is no longer ~0 % (imported coal, LNG and oil), recomputed from the raw CSV', () => {
    const r = row('electricity-import-exposure', 'JPN')!;
    expect(r.year).toBe(2024);
    const dep = (f: string) => Math.max(0, Math.min(1, (rawAt('JPN', 2024, f + '_energy_twh')! - rawAt('JPN', 2024, f + '_production_twh')!) / rawAt('JPN', 2024, f + '_energy_twh')!));
    const G = rawAt('JPN', 2024, 'electricity_generation_twh')!, N = rawAt('JPN', 2024, 'electricity_net_imports_twh')!;
    const fuel = ['coal', 'gas', 'oil'].reduce((a, f) => a + rawAt('JPN', 2024, f + '_electricity_twh')! * dep(f), 0);
    expect(r.value).toBeCloseTo((100 * (Math.max(N, 0) + fuel)) / (G + Math.max(N, 0)), 8);
    expect(r.value).toBeGreaterThan(60);
    expect(row('owid-electricity-net-import-share', 'JPN')!.value).toBe(0); // direct trade alone says 0
    expect(row('eia-electricity-net-import-share', 'JPN')!.value).toBeLessThan(1);
  });

  it('import exposure: reference cases (all imported, net exporters, fuel producers, bounds only)', () => {
    const v = (k: string) => row('electricity-import-exposure', k)!.value;
    const b = byId('electricity-import-exposure').breakdown!.byKey;
    expect(v('LSO')).toBe(100); // all power imported, no fuel burned
    expect(b.LSO.direct).toBe(100);
    expect(v('SGP')).toBeGreaterThan(90); // gas-fired, no domestic gas
    expect(v('USA')).toBeLessThan(1); // net exporter of gas and coal: only direct imports
    expect(v('PRY')).toBe(0); // hydro, net exporter
    expect(v('FRA')).toBeLessThan(10); // nuclear (uranium not counted, see caveat)
    expect(b.FRA.direct).toBe(0);
    // A burned fuel without EI dependence data gives no value, only bounds (never a guess).
    expect(v('BRB')).toBeNull();
    expect(b.BRB.exact).toBe(false);
    expect(b.BRB.low).toBeLessThan(b.BRB.high);
    expect(b.BRB.parts.oil.dependence).toBeNull();
    for (const [k, e] of Object.entries(b)) {
      expect(e.low, k).toBeGreaterThanOrEqual(0);
      expect(e.high, k).toBeLessThanOrEqual(100 + 1e-9);
      if (e.exact) expect(v(k), k).toBeCloseTo(e.low, 9);
      // breakdown adds up
      const sum = e.direct + Object.values(e.parts).reduce((a, p) => a + (p.contribution ?? 0), 0);
      expect(sum, k).toBeCloseTo(e.low, 6);
    }
    const n = byId('electricity-import-exposure').rows.filter((r) => r.value !== null);
    expect(n.length).toBeGreaterThan(80);
    for (const r of n) expect(r.year, r.key).toBeGreaterThanOrEqual(2022); // stale values dropped (maxLagYears)
  });

  it('derived specs are recomputed in dependency order (exposure uses the fuel dependence datasets)', () => {
    const spec: DerivedSpec = json('data/sources/electricity-import-exposure.derived.json');
    expect(deriveInputs(spec.derive)).toContain('owid-gas-net-import-dependence');
    expect(spec.dataset.scoring.include).toBe(true);
    expect(byId('eia-electricity-net-import-share').scoring.include).toBe(false); // no double counting
  });
});
