import { describe, it, expect } from 'vitest';
import { parseCsv, csvToObjects } from '../src/lib/csv';
import { normalize, parseValue, readRows, UnmatchedError, type SourceSpec } from '../src/lib/importer';
import { normalizeName, buildMatcher } from '../src/lib/names';
import { flattenEiaSeriesExport, parseEiaValue, eiaExportStamp } from '../src/lib/eia';
import { deriveDataset, type DerivedSpec } from '../src/lib/derive';
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
