import { describe, it, expect } from 'vitest';
import { parseCsv, csvToObjects } from '../src/lib/csv';
import { normalize, parseValue, readRows, readRowsCached, UnmatchedError, type SourceSpec } from '../src/lib/importer';
import { normalizeName, buildMatcher } from '../src/lib/names';
import { flattenEiaSeriesExport, parseEiaValue, eiaExportStamp } from '../src/lib/eia';
import { deriveDataset, deriveInputs, electricityExposure, type DerivedSpec } from '../src/lib/derive';
import type { Dataset, Entity } from '../src/lib/types';

const entities: Entity[] = [
  { key: 'USA', name: 'United States', type: 'country', iso3: 'USA', iso2: 'US', numeric: '840', aliases: ['United States of America'] },
  { key: 'CIV', name: "Côte d'Ivoire", type: 'country', iso3: 'CIV', iso2: 'CI' },
  { key: 'COG', name: 'Congo (Republic)', type: 'country', iso3: 'COG', aliases: ['Congo'] },
  { key: 'COD', name: 'Congo (Democratic Republic)', type: 'country', iso3: 'COD', aliases: ['Congo'] },
  { key: 'PRI', name: 'Puerto Rico', type: 'territory', iso3: 'PRI', parent: 'USA' },
  { key: 'USA-CA', name: 'California', type: 'subnational', parent: 'USA', aliases: ['US-CA'] },
];
const aliasFile = { aliases: { 'Congo, Rep.': 'COG' }, nonEntities: { World: 'aggregate', WLD: 'aggregate code' } };

const baseMeta = {
  id: 't', title: 't', category: 'food', year: 2022,
  indicator: { name: 'x', unit: '%' }, source: { name: 's', url: 'u', license: 'l' },
  scoring: { include: true, direction: 'higher_more_dependent' as const, method: 'fixed-range' as const, range: [0, 100] as [number, number] },
};

describe('csv', () => {
  it('handles quotes, escaped quotes, CRLF and BOM', () => {
    expect(parseCsv('\ufeffa,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });
  it('skips preamble lines (World Bank CSV style)', () => {
    expect(csvToObjects('Data Source,WDI\n\nCountry Name,2022\nAruba,1.5\n', { skipLines: 1 })).toEqual([{ 'Country Name': 'Aruba', '2022': '1.5' }]);
  });
});

describe('names', () => {
  it('normalizes accents, punctuation, case and leading "the"', () => {
    expect(normalizeName("Côte d'Ivoire")).toBe('cote d ivoire');
    expect(normalizeName('The Gambia')).toBe('gambia');
    expect(normalizeName('Bosnia & Herzegovina')).toBe('bosnia and herzegovina');
  });
  it('matches names, aliases, codes, sub-national keys; drops ambiguous aliases', () => {
    const m = buildMatcher(entities, aliasFile);
    expect(m.match('united states of america')).toEqual({ key: 'USA' });
    expect(m.match('Cote dIvoire')).toBeNull(); // different tokenization is not guessed
    expect(m.match("Cote d'Ivoire")).toEqual({ key: 'CIV' });
    expect(m.match('US')).toEqual({ key: 'USA' });
    expect(m.match('PRI')).toEqual({ key: 'PRI' });
    expect(m.match('US-CA')).toEqual({ key: 'USA-CA' });
    expect(m.match('USA-CA')).toEqual({ key: 'USA-CA' });
    expect(m.match('Congo')).toBeNull(); // ambiguous between COG and COD
    expect(m.match('Congo, Rep.')).toEqual({ key: 'COG' });
    expect(m.match('World')).toEqual({ skip: 'aggregate' });
  });
  it('rejects aliases pointing at unknown keys', () => {
    const m = buildMatcher(entities, { aliases: { Foo: 'XXX' }, nonEntities: {} });
    expect(() => m.match('Foo')).toThrow(/unknown entity key/);
  });
});

describe('parseValue', () => {
  it('parses numbers and treats missing markers as null (never 0)', () => {
    expect(parseValue(12.5)).toBe(12.5);
    expect(parseValue('1,234.5')).toBe(1234.5);
    expect(parseValue('45%')).toBe(45);
    expect(parseValue('')).toBeNull();
    expect(parseValue('..')).toBeNull();
    expect(parseValue(null)).toBeNull();
    expect(parseValue(undefined)).toBeNull();
    expect(() => parseValue('abc')).toThrow();
  });
});

describe('normalize', () => {
  it('JSON rows by name: keeps explicit nulls as missing, skips aggregates, sorts by key', () => {
    const spec: SourceSpec = { input: 'x.json', format: 'json', rowsPath: 'data', entityField: 'c', valueField: 'v', year: 2022, dataset: baseMeta };
    const rows = readRows(spec, JSON.stringify({ data: [{ c: 'United States', v: 10 }, { c: 'World', v: 50 }, { c: 'Puerto Rico', v: null }] }));
    const ds = normalize(spec, rows, entities, aliasFile);
    expect(ds.rows).toEqual([
      { key: 'PRI', value: null, year: 2022, sourceName: 'Puerto Rico' },
      { key: 'USA', value: 10, year: 2022, sourceName: 'United States' },
    ]);
    expect(ds.import.missingValues).toBe(1);
    expect(ds.import.skipped).toEqual([{ name: 'World', reason: 'aggregate' }]);
    expect(ds.schemaVersion).toBe(1);
    expect(ds.category).toBe('food');
  });

  it('strict mode fails loudly on unmatched labels', () => {
    const spec: SourceSpec = { input: '', format: 'json', entityField: 'c', valueField: 'v', year: 2022, dataset: baseMeta };
    expect(() => normalize(spec, [{ c: 'Atlantis', v: 1 }], entities, aliasFile)).toThrow(UnmatchedError);
    const loose = normalize({ ...spec, strict: false }, [{ c: 'Atlantis', v: 1 }], entities, aliasFile);
    expect(loose.rows).toEqual([]);
    expect(loose.import.skipped[0].name).toBe('Atlantis');
  });

  it('wide CSV (World Bank style): picks the most recent non-empty year column, by ISO3 code, with scale', () => {
    const csv = 'Country Name,Country Code,2021,2022,2023\nUnited States,USA,1,2,\nPuerto Rico,PRI,,,\nWorld,WLD,5,5,5\n';
    const spec: SourceSpec = { input: '', format: 'csv', entityField: 'Country Code', valueColumns: ['2021', '2022', '2023'], scale: 10, dataset: baseMeta };
    const ds = normalize(spec, readRows(spec, csv), entities, aliasFile);
    expect(ds.rows).toEqual([
      { key: 'PRI', value: null, year: 2023, sourceName: 'PRI' },
      { key: 'USA', value: 20, year: 2022, sourceName: 'USA' },
    ]);
  });

  it('long format: keeps the latest year with a value per entity; applies where filter', () => {
    const rows = [
      { iso: 'USA', year: '2020', v: '1', item: 'cereal' },
      { iso: 'USA', year: '2022', v: '3', item: 'cereal' },
      { iso: 'USA', year: '2023', v: '', item: 'cereal' },
      { iso: 'USA', year: '2023', v: '99', item: 'meat' },
    ];
    const spec: SourceSpec = { input: '', format: 'csv', entityField: 'iso', valueField: 'v', yearField: 'year', where: { item: 'cereal' }, dataset: baseMeta };
    const ds = normalize(spec, rows, entities, aliasFile);
    expect(ds.rows).toEqual([{ key: 'USA', value: 3, year: 2022, sourceName: 'USA' }]);
  });

  it('dedupes identical duplicates and rejects conflicting ones', () => {
    const spec: SourceSpec = { input: '', format: 'json', entityField: 'c', valueField: 'v', year: 2022, dataset: baseMeta };
    const ok = normalize(spec, [{ c: 'United States', v: 1 }, { c: 'USA', v: 1 }], entities, aliasFile);
    expect(ok.rows).toHaveLength(1);
    expect(ok.import.duplicates).toEqual([{ key: 'USA', names: ['United States', 'USA'] }]);
    expect(() => normalize(spec, [{ c: 'United States', v: 1 }, { c: 'USA', v: 2 }], entities, aliasFile)).toThrow(/conflicting/);
  });
});

// ---------- EIA SeriesExport ----------
const jan1 = (y: number) => Date.UTC(y, 0, 1);
const eiaSeries = (iso: string, unit: string, activity: string, vals: Record<number, string>) => ({
  series_id: `INTL.57-${activity}-${iso}-${unit}.A`, name: `Crude oil imports, ${iso}, Annual`, frequency: 'A',
  productid: '57', activityid: activity, iso, unit,
  data: Object.entries(vals).map(([y, value]) => ({ date: jan1(Number(y)), value })),
});
const eiaMeta = (id: string, unit = 'TBPD') => ({ ...baseMeta, id, category: 'energy', indicator: { name: id, unit } });
const eiaSpec = (activity: string, id: string, unit = 'TBPD'): SourceSpec => ({
  input: 'x.json', format: 'eia-series', entityField: 'iso', valueField: 'value', yearField: 'year',
  where: { productid: '57', activityid: activity }, unitField: 'unit', flagField: 'flag', markerField: 'marker', keepSeries: true,
  dataset: eiaMeta(id, unit),
});
const eiaAliases = { aliases: {}, nonEntities: { WORL: 'EIA world total' } };

describe('EIA SeriesExport parsing', () => {
  it('parses numbers, flagged values and markers; never turns markers into 0', () => {
    expect(parseEiaValue('5876.525')).toEqual({ value: 5876.525 });
    expect(parseEiaValue('.25')).toEqual({ value: 0.25 });
    expect(parseEiaValue('0')).toEqual({ value: 0 });
    expect(parseEiaValue('p|193012')).toEqual({ value: 193012, flag: 'p' });
    expect(parseEiaValue('--')).toEqual({ value: null, marker: '--' });
    expect(parseEiaValue('NA')).toEqual({ value: null, marker: 'NA' });
    expect(parseEiaValue('ie')).toEqual({ value: null, marker: 'ie' });
    expect(() => parseEiaValue('W')).toThrow(/Unparseable/);
  });

  it('flattens series to one row per year (UTC Jan 1 dates) and rejects non-annual data', () => {
    const rows = flattenEiaSeriesExport(JSON.stringify([eiaSeries('USA', 'TBPD', '3', { 2019: '1.5', 2020: 'p|2', 2021: 'NA' })]));
    expect(rows.map((r) => [r.iso, r.year, r.value, r.flag, r.marker])).toEqual([
      ['USA', 2019, 1.5, undefined, undefined], ['USA', 2020, 2, 'p', undefined], ['USA', 2021, null, undefined, 'NA'],
    ]);
    expect(() => flattenEiaSeriesExport(JSON.stringify([{ ...eiaSeries('USA', 'TBPD', '3', {}), frequency: 'M' }]))).toThrow(/annual/);
    const mid = eiaSeries('USA', 'TBPD', '3', {}); mid.data = [{ date: Date.UTC(2020, 5, 1), value: '1' }];
    expect(() => flattenEiaSeriesExport(JSON.stringify([mid]))).toThrow(/non-annual/);
    expect(() => flattenEiaSeriesExport('{}')).toThrow(/array/);
  });

  it('reads the export time from the filename as written', () => {
    expect(eiaExportStamp('data/raw/eia/petrol-import-SeriesExport-10-12-2026-18-11-05.json')).toBe('2026-10-12 18:11:05');
    expect(eiaExportStamp('foo.json')).toBeNull();
  });

  it('normalizes via the generic importer: latest numeric year, flags follow the value, markers counted, aggregates skipped, series kept', () => {
    const text = JSON.stringify([
      eiaSeries('USA', 'TBPD', '3', { 2019: '1.5', 2020: 'p|2', 2021: 'NA' }),
      eiaSeries('PRI', 'TBPD', '3', { 2019: '--', 2020: '--', 2021: '--' }),
      eiaSeries('WORL', 'TBPD', '3', { 2019: '10', 2020: '11', 2021: '12' }),
      eiaSeries('USA', 'TBPD', '4', { 2019: '9', 2020: '9', 2021: '9' }), // other activity: filtered out by "where"
    ]);
    const spec = eiaSpec('3', 'imp');
    const ds = normalize(spec, readRows(spec, text), entities, eiaAliases);
    expect(ds.rows).toEqual([
      { key: 'PRI', value: null, year: 2021, sourceName: 'PRI' },
      { key: 'USA', value: 2, year: 2020, sourceName: 'USA', flag: 'p' },
    ]);
    expect(ds.import.markers).toEqual({ NA: 1, '--': 3 });
    expect(ds.import.skipped).toEqual([{ name: 'WORL', reason: 'EIA world total' }]); // listed once, not once per year
    expect(ds.series).toEqual({ start: 2019, end: 2021, values: { USA: [1.5, 2, null] }, flags: { USA: { '2020': 'p' } } });
  });

  it('refuses rows whose stated unit differs from the declared unit', () => {
    const text = JSON.stringify([eiaSeries('USA', 'BCF', '3', { 2020: '1' })]);
    const spec = eiaSpec('3', 'imp', 'TBPD');
    expect(() => normalize(spec, readRows(spec, text), entities, eiaAliases)).toThrow(/unit "BCF" but the dataset declares "TBPD"/);
  });
});

describe('derived datasets', () => {
  const mk = (id: string, unit: string, start: number, values: Record<string, (number | null)[]>): Dataset => ({
    schemaVersion: 1, ...eiaMeta(id, unit), scoring: { include: false, direction: 'higher_more_dependent', method: 'minmax' },
    import: { from: '', spec: '', rowsRead: 0, matched: 0, missingValues: 0, skipped: [], duplicates: [] },
    rows: Object.keys(values).map((key) => ({ key, value: null, year: start })), series: { start, end: start + 2, values },
  });
  const inputs = new Map<string, Dataset>([
    ['imp', mk('imp', 'BKWH', 2020, { USA: [1, 2, 3], PRI: [1, null, null], CIV: [null, null, 5] })],
    ['exp', mk('exp', 'BKWH', 2020, { USA: [0.5, 0.1, null], PRI: [0, 4, null], CIV: [null, 1, null] })],
    ['cons', mk('cons', 'BKWH', 2020, { USA: [10, 20, 30], PRI: [0, 10, 10] })],
  ]);
  const meta = (id: string, unit: string) => ({ ...eiaMeta(id, unit), scoring: { include: false, direction: 'higher_more_dependent' as const, method: 'minmax' as const } });

  it('net = imports − exports in the latest year where both exist; no common year -> explicitly missing', () => {
    const spec: DerivedSpec = { derive: { op: 'net', imports: 'imp', exports: 'exp' }, dataset: meta('net', 'BKWH') };
    const ds = deriveDataset(spec, inputs);
    expect(ds.rows).toEqual([
      { key: 'CIV', value: null, year: 2022 },
      { key: 'PRI', value: 1, year: 2020 },
      { key: 'USA', value: 1.9, year: 2021 }, // 2022 has no export value, so 2021 is used (2 − 0.1, float noise trimmed)
    ]);
    expect(ds.series!.values.USA).toEqual([0.5, 1.9, null]);
    expect(ds.import.missingValues).toBe(1);
  });

  it('net-share = 100 × (imports − exports) ÷ base, only when base > 0', () => {
    const spec: DerivedSpec = { derive: { op: 'net-share', imports: 'imp', exports: 'exp', base: 'cons' }, dataset: meta('share', '% of consumption') };
    const ds = deriveDataset(spec, inputs);
    expect(ds.rows.find((r) => r.key === 'USA')).toEqual({ key: 'USA', value: 9.5, year: 2021 });
    expect(ds.rows.find((r) => r.key === 'PRI')).toEqual({ key: 'PRI', value: null, year: 2022 }); // 2020 base is 0, 2021 has no import value
  });

  it('refuses to combine different units or missing inputs', () => {
    const bad = new Map(inputs); bad.set('exp', mk('exp', 'TBPD', 2020, { USA: [1, 1, 1] }));
    expect(() => deriveDataset({ derive: { op: 'net', imports: 'imp', exports: 'exp' }, dataset: meta('n', 'BKWH') }, bad)).toThrow(/different units/);
    expect(() => deriveDataset({ derive: { op: 'net', imports: 'imp', exports: 'nope' }, dataset: meta('n', 'BKWH') }, inputs)).toThrow(/not found/);
    expect(() => deriveDataset({ derive: { op: 'net', imports: 'imp', exports: 'exp' }, dataset: meta('n', 'TBPD') }, inputs)).toThrow(/output unit/);
  });
});

describe('OWID-style long CSV (entity fallback, minYear, cached parse)', () => {
  const csv = 'country,year,iso_code,v\nUnited States,1989,USA,7\nUnited States,1990,USA,1\nUnited States,1991,USA,\nPuerto Rico,1991,PRI,\nWorld,1991,,9\nCalifornia,1991,,4\n';
  const spec: SourceSpec = { input: 'mem.csv', format: 'csv', entityField: 'iso_code', entityFallbackField: 'country', valueField: 'v', yearField: 'year', minYear: 1990, keepSeries: true, dataset: baseMeta };
  it('matches blank codes by the fallback name, skips aggregates, ignores rows before minYear, keeps blanks missing', () => {
    const ds = normalize(spec, readRows(spec, csv), entities, aliasFile);
    expect(ds.rows).toEqual([
      { key: 'PRI', value: null, year: 1991, sourceName: 'PRI' },
      { key: 'USA', value: 1, year: 1990, sourceName: 'USA' }, // 1989 (7) is before minYear; 1991 is blank -> not 0
      { key: 'USA-CA', value: 4, year: 1991, sourceName: 'California' },
    ]);
    expect(ds.import.skipped).toEqual([{ name: 'World', reason: 'aggregate' }]);
    expect(ds.import.minYear).toBe(1990);
    expect(ds.series).toEqual({ start: 1990, end: 1991, values: { USA: [1, null], 'USA-CA': [null, 4] } });
  });
  it('parses a shared raw file once per process', () => {
    let reads = 0;
    const read = () => { reads++; return csv; };
    const a = readRowsCached(spec, read);
    const b = readRowsCached({ ...spec, valueField: 'other' }, read);
    expect(a).toBe(b);
    expect(reads).toBe(1);
  });
});

describe('fuel dependence and electricity import exposure', () => {
  const mk = (id: string, unit: string, values: Record<string, (number | null)[]>): Dataset => ({
    schemaVersion: 1, ...baseMeta, id, category: 'energy', indicator: { name: id, unit }, scoring: { include: false, direction: 'higher_more_dependent', method: 'minmax' },
    import: { from: '', spec: '', rowsRead: 0, matched: 0, missingValues: 0, skipped: [], duplicates: [] },
    rows: Object.keys(values).map((key) => ({ key, value: null, year: 2020 })), series: { start: 2020, end: 2021, values },
  });
  const meta = (id: string, unit: string) => ({ ...baseMeta, id, category: 'energy', indicator: { name: id, unit }, scoring: { include: false, direction: 'higher_more_dependent' as const, method: 'minmax' as const } });

  it('electricityExposure: formula, zero-generation rule, net exporter denominator, bounds when a dependence is missing', () => {
    // Japan-like: no trade, 300 coal (99 % imported), 350 gas (97.5 %), 25 oil (100 %), G = 1000.
    const jp = electricityExposure(1000, 0, [{ id: 'coal', generation: 300, dependence: 99 }, { id: 'gas', generation: 350, dependence: 97.5 }, { id: 'oil', generation: 25, dependence: 100 }])!;
    expect(jp.exact).toBe(true);
    expect(jp.low).toBeCloseTo(100 * (300 * 0.99 + 350 * 0.975 + 25) / 1000, 9);
    expect(jp.parts.gas).toEqual({ share: 35, dependence: 97.5, contribution: 34.125 });
    // Net importer: S = G + N. Exporter dependence (negative) counts as 0; above 100 % counts as 100 %.
    const imp = electricityExposure(80, 20, [{ id: 'gas', generation: 40, dependence: -50 }, { id: 'oil', generation: 10, dependence: 130 }])!;
    expect(imp.direct).toBe(20);
    expect(imp.parts.gas.contribution).toBe(0);
    expect(imp.low).toBe(30); // 20 direct + 10 % oil
    // Net exporter: S = G (exports assumed to have the generation mix), direct = 0.
    const exp = electricityExposure(200, -50, [{ id: 'gas', generation: 100, dependence: 50 }])!;
    expect(exp).toMatchObject({ direct: 0, low: 25, exact: true });
    // A fuel with zero generation needs no dependence; a burned fuel without one gives only bounds.
    expect(electricityExposure(0, 5, [{ id: 'oil', generation: 0, dependence: null }])).toMatchObject({ exact: true, low: 100, high: 100 });
    const b = electricityExposure(100, 0, [{ id: 'oil', generation: 60, dependence: null }, { id: 'gas', generation: 20, dependence: 50 }])!;
    expect(b).toMatchObject({ exact: false, low: 10, high: 70 });
    expect(b.parts.oil).toEqual({ share: 60, dependence: null, contribution: null });
    // Missing generation or trade, or nothing supplied: no result at all.
    expect(electricityExposure(null, 0, [])).toBeNull();
    expect(electricityExposure(100, null, [])).toBeNull();
    expect(electricityExposure(100, 0, [{ id: 'coal', generation: null, dependence: 10 }])).toBeNull();
    expect(electricityExposure(0, -1, [])).toBeNull();
  });

  const inputs = new Map<string, Dataset>([
    ['sup', mk('sup', 'TWh', { USA: [100, 120], PRI: [0, 10], CIV: [50, null] })],
    ['prod', mk('prod', 'TWh', { USA: [150, 60], PRI: [0, 0], CIV: [10, 10] })],
    ['G', mk('G', 'TWh', { USA: [1000, 1000], PRI: [10, 10], CIV: [5, 5] })],
    ['N', mk('N', 'TWh', { USA: [0, 0], PRI: [0, 0], CIV: [1, 1] })],
    ['gGas', mk('gGas', 'TWh', { USA: [400, 500], PRI: [10, 10], CIV: [0, 2] })],
  ]);

  it('dependence = 100 × (supply − production) ÷ supply; supply must be > 0; negative = net exporter', () => {
    const ds = deriveDataset({ derive: { op: 'dependence', supply: 'sup', production: 'prod' }, dataset: meta('dep', '% of supply') }, inputs);
    expect(ds.series!.values.USA).toEqual([-50, 50]);
    expect(ds.series!.values.PRI).toEqual([null, 100]);
    expect(ds.rows.find((r) => r.key === 'CIV')).toEqual({ key: 'CIV', value: 80, year: 2020 });
    inputs.set('dep', ds);
  });

  it('electricity-exposure op: per-year values, breakdown, bounds, stale-value rule and unit checks', () => {
    const spec: DerivedSpec = { derive: { op: 'electricity-exposure', generation: 'G', netImports: 'N', fuels: [{ id: 'gas', label: 'Gas', generation: 'gGas', dependence: 'dep' }] }, dataset: meta('ex', '% of electricity supply') };
    expect(deriveInputs(spec.derive)).toEqual(['G', 'N', 'gGas', 'dep']);
    const ds = deriveDataset(spec, inputs);
    expect(ds.series!.values.USA).toEqual([0, 25]); // 2020: gas exported (dep −50 → 0); 2021: 500/1000 × 50 %
    expect(ds.rows.find((r) => r.key === 'PRI')).toEqual({ key: 'PRI', value: 100, year: 2021 }); // 2020: supply 0 -> no dependence -> bounds only
    // CIV 2021: gas burned (2) but dependence missing -> no value that year; 2020 exact (no gas burned): 1/6 direct.
    const civ = ds.rows.find((r) => r.key === 'CIV')!;
    expect(civ.year).toBe(2020);
    expect(civ.value).toBeCloseTo(100 / 6, 9);
    expect(ds.breakdown!.byKey.CIV).toMatchObject({ year: 2020, exact: true });
    // With maxLagYears 0 the 2020 value is stale next to 2021 data: missing, and the 2021 bounds are shown.
    const strict = deriveDataset({ ...spec, derive: { ...spec.derive, maxLagYears: 0 } as DerivedSpec['derive'] }, inputs);
    expect(strict.rows.find((r) => r.key === 'CIV')!.value).toBeNull();
    expect(strict.breakdown!.byKey.CIV).toMatchObject({ year: 2021, exact: false });
    expect(strict.breakdown!.byKey.CIV.low).toBeCloseTo(100 / 6, 9);
    expect(strict.breakdown!.byKey.CIV.high).toBeCloseTo(100 * 3 / 6, 9);
    expect(strict.series!.values.CIV[0]).toBeCloseTo(100 / 6, 9); // still in the series for the trend chart
    expect(ds.breakdown!.parts).toEqual([{ id: 'gas', label: 'Gas' }]);
    // Units: energy inputs must share one unit; dependence must be a %.
    const bad = new Map(inputs); bad.set('gGas', mk('gGas', 'BKWH', { USA: [1, 1] }));
    expect(() => deriveDataset(spec, bad)).toThrow(/different units/);
    const bad2 = new Map(inputs); bad2.set('dep', mk('dep', 'TWh', { USA: [1, 1] }));
    expect(() => deriveDataset(spec, bad2)).toThrow(/must be a %/);
  });
});
