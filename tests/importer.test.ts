import { describe, it, expect } from 'vitest';
import { parseCsv, csvToObjects } from '../src/lib/csv';
import { normalize, parseValue, readRows, UnmatchedError, type SourceSpec } from '../src/lib/importer';
import { normalizeName, buildMatcher } from '../src/lib/names';
import type { Entity } from '../src/lib/types';

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
