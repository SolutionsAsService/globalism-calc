/**
 * Shared data model for globalism-calc.
 * Used by the importer scripts (Node) and the browser app.
 */

/** country = sovereign state; territory = dependent territory / SAR / overseas region with its own code;
 * subnational = state/province (key = PARENT_ISO3 + '-' + ISO 3166-2 suffix, e.g. USA-CA);
 * other = uninhabited or special areas (e.g. Antarctica). */
export type EntityType = 'country' | 'territory' | 'subnational' | 'other';

export interface Entity {
  /** Stable key: ISO 3166-1 alpha-3 for countries/territories, PARENT-SUB for subnational. */
  key: string;
  name: string;
  type: EntityType;
  iso3?: string;
  iso2?: string;
  /** ISO 3166-1 numeric code as a 3-char string (used to join the world map). */
  numeric?: string;
  /** Sovereign/parent entity key, for territories and subnational units. */
  parent?: string;
  /** Alternate names used for matching source data (normalized at match time). */
  aliases?: string[];
  note?: string;
}

export type ScoringMethod = 'fixed-range' | 'minmax' | 'log-minmax' | 'percentile';
export type ScoringDirection = 'higher_more_dependent' | 'lower_more_dependent';

export interface ScoringSpec {
  /** Whether this indicator contributes to its category's dependency score. */
  include: boolean;
  direction: ScoringDirection;
  method: ScoringMethod;
  /** Required for fixed-range: [value that maps to 0, value that maps to 100] (before direction). */
  range?: [number, number];
  /** Weight of this indicator inside its category (default 1). */
  weight?: number;
  /** Why the indicator is (not) scored. Shown in the UI. */
  rationale?: string;
}

export interface DatasetRow {
  key: string;
  /** null = the source lists the entity but has no value (explicitly missing). */
  value: number | null;
  year: number;
  /** The entity label exactly as it appeared in the source. */
  sourceName?: string;
  /** Source flag on the value, verbatim (e.g. EIA "p" on 2024 values). */
  flag?: string;
}

/** Optional grouping for categories with many related datasets (e.g. energy: fuel × flow). */
export interface DatasetView {
  /** Group id, e.g. "crude-oil". */
  group: string;
  groupLabel: string;
  /** Flow id within the group, e.g. "imports", "exports", "net-imports", "consumption", "net-import-share". */
  flow: string;
  flowLabel: string;
  /** Sort order of the group (ascending). */
  order: number;
  /** Shown first when the category is opened. */
  default?: boolean;
}

/** Full annual series kept next to the latest-value rows (values[key][i] is the value for year start + i). */
export interface DatasetSeries {
  start: number;
  end: number;
  values: Record<string, (number | null)[]>;
  /** Source flags per entity and year, e.g. { CHN: { "2024": "p" } }. */
  flags?: Record<string, Record<string, string>>;
}

export interface DatasetMeta {
  id: string;
  title: string;
  category: string;
  /** unit = unit code as stated by the source (e.g. EIA "TBPD"); unitLabel = its spelled-out meaning. */
  indicator: { code?: string; name: string; unit: string; unitLabel?: string; description?: string };
  source: { name: string; url: string; license: string; citation?: string; retrieved?: string };
  year: number;
  notes?: string[];
  caveats?: string[];
  scoring: ScoringSpec;
  view?: DatasetView;
}

export interface ImportReport {
  from: string;
  spec: string;
  rowsRead: number;
  matched: number;
  missingValues: number;
  skipped: { name: string; reason: string }[];
  duplicates: { key: string; names: string[] }[];
  /** Counts of non-numeric source markers seen in the rows read (all years), e.g. {"NA": 12, "--": 40}. */
  markers?: Record<string, number>;
}

export interface Dataset extends DatasetMeta {
  schemaVersion: 1;
  import: ImportReport;
  rows: DatasetRow[];
  series?: DatasetSeries;
}

export interface CategoryDef {
  id: string;
  label: string;
  /** Short description of what dependence means for this category. */
  description: string;
  /** Default weight in the composite index. */
  defaultWeight: number;
  /** Ideal indicators we still need; shown as "data needed" when no scored dataset exists. */
  wanted?: { name: string; source: string; url?: string; why?: string }[];
}

export interface Manifest {
  generatedFrom: string;
  datasets: { id: string; file: string; category: string; title: string }[];
  categories: string;
  entities: string;
  geo: string;
}
