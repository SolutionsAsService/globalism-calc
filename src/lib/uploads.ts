import type { SourceSpec } from './importer';
import type { Dataset } from './types';

/** A file in data/datasets is normalized when it was written by the importer. Anything else is a raw upload. */
export const isNormalized = (x: unknown): x is Dataset =>
  !!x && typeof x === 'object' && (x as Dataset).schemaVersion === 1 && Array.isArray((x as Dataset).rows) && typeof (x as Dataset).category === 'string';

/** World Bank indicator code prefix -> category (exports are context: they describe exposure, not import dependence). */
const WB_CATEGORY: [RegExp, string][] = [
  [/^T[MX]\.VAL\.FOOD/, 'food'],
  [/^T[MX]\.VAL\.(MRCH\.MT|MMTL)/, 'minerals'],
  [/^T[MX]\.VAL\.(MRCH\.MF|MANF)/, 'manufactured'],
  [/^T[MX]\.VAL\.(FUEL|MRCH\.FL)/, 'energy'],
  [/^NE\.(TRD|IMP)/, 'trade'],
];

const slug = (s: string) => s.toLowerCase().replace(/\.json$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

type Obj = Record<string, any>;

/**
 * Build a source spec for a recognized upload shape, or return null (then a spec must be written by hand).
 * Recognized: World Bank "most recent value" tables: { indicator: { code, name }, entities: [{ entity_name, most_recent_year, most_recent_value_percent }] }.
 */
export function autoSpec(input: string, raw: Obj): SourceSpec | null {
  const ents = raw?.entities;
  const code: string | undefined = raw?.indicator?.code;
  if (!Array.isArray(ents) || !code || !ents.some((e: Obj) => 'most_recent_value_percent' in e && 'entity_name' in e)) return null;
  const category = WB_CATEGORY.find(([re]) => re.test(code))?.[1];
  if (!category) return null;
  const exports = code.startsWith('TX.');
  const years = ents.map((e: Obj) => Number(e.most_recent_year)).filter(Number.isFinite);
  const meta = raw.source_metadata ?? {};
  const name: string = raw.indicator.name;
  return {
    input,
    format: 'json',
    rowsPath: 'entities',
    entityField: 'entity_name',
    valueField: 'most_recent_value_percent',
    yearField: 'most_recent_year',
    // Older "latest" observations (1978–2008 in the uploaded tables) are not current enough to score next to 2024–25 data.
    minYear: 2010,
    dataset: {
      id: 'wb-' + slug(code),
      title: name + ' (latest)',
      category,
      indicator: { code, name, unit: '%', description: raw.indicator.definition },
      source: {
        name: 'World Bank, World Development Indicators (' + code + ')',
        url: meta.source_page ?? 'https://data.worldbank.org/indicator/' + code,
        license: 'CC BY 4.0',
        citation: 'World Bank WDI ' + code + ', underlying UN Comtrade / WITS. Table transcribed and uploaded to this repo (' + input + ').',
      },
      year: Math.max(...years),
      notes: [
        'Auto-imported from an uploaded "most recent value" table: each entity keeps its own latest year (' + Math.min(...years) + '–' + Math.max(...years) + '), so old observations sit next to recent ones.',
        'World Bank aggregates are skipped; blank cells stay missing (never zero). Observations older than 2010 are not used (they were 1975–2008 for a few economies such as Somalia, Chad and Equatorial Guinea).',
      ],
      caveats: [
        exports
          ? 'Share of merchandise exports: shows how much an economy earns from this product group, not how much it depends on imports. Context only.'
          : 'Composition of merchandise imports, not import dependence: a high share can mean a big need for imports of this group or simply few other imports. Shares are rounded in the source table.',
      ],
      scoring: exports
        ? { include: false, direction: 'higher_more_dependent', method: 'percentile', rationale: 'Export composition is context (exposure to world prices), not dependence on others.' }
        : { include: true, direction: 'higher_more_dependent', method: 'percentile', rationale: 'Share of imports with no natural ceiling for this purpose; rank-based so outliers do not dominate.' },
    },
  };
}
