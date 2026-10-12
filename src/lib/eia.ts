/**
 * Reader for U.S. EIA International Energy Data "SeriesExport" JSON files (data browser export:
 * https://www.eia.gov/international/data/world). A file is an array of series, one per country/area:
 *   { series_id: "INTL.57-3-USA-TBPD.A", name: "..., United States, Annual", frequency: "A",
 *     productid: "57", activityid: "3", iso: "USA", unit: "TBPD",
 *     data: [{ date: <epoch ms, Jan 1 UTC>, value: "5876.525" | "--" | "NA" | "ie" | "p|193012" }] }
 * Pure functions; no file system access.
 */

export interface EiaSeries {
  series_id: string;
  name: string;
  frequency: string;
  productid: string;
  activityid: string;
  iso: string;
  unit: string;
  data: { date: number; value: unknown }[];
}

/** One (series, year) observation, flattened so the generic importer can treat it as a long-format row. */
export interface EiaRow {
  series_id: string;
  name: string;
  productid: string;
  activityid: string;
  iso: string;
  unit: string;
  year: number;
  value: number | null;
  /** Flag written before the value as "flag|value" (e.g. "p"); kept verbatim. */
  flag?: string;
  /** Non-numeric marker that replaced the value ("--", "NA", "ie"); the value is then null. */
  marker?: string;
}

/** Markers EIA writes instead of a number. All become explicit missing values (never 0). */
export const EIA_MARKERS = ['--', 'NA', 'ie'] as const;

const NUM = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

function toNumber(s: string): number {
  if (!NUM.test(s)) throw new Error(`Unparseable EIA value: "${s}"`);
  return Number(s);
}

/** Parse one EIA cell. "p|1.5" -> { value: 1.5, flag: "p" }; "NA" -> { value: null, marker: "NA" }. Unknown text throws. */
export function parseEiaValue(v: unknown): { value: number | null; flag?: string; marker?: string } {
  if (v === null || v === undefined) return { value: null, marker: 'null' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Unparseable EIA value: ${v}`);
    return { value: v };
  }
  const s = String(v).trim();
  if ((EIA_MARKERS as readonly string[]).includes(s)) return { value: null, marker: s };
  const flagged = /^([A-Za-z]+)\|(.+)$/.exec(s);
  if (flagged) return { value: toNumber(flagged[2].trim()), flag: flagged[1] };
  return { value: toNumber(s) };
}

/** Flatten a SeriesExport file into one row per series per year. Only annual series are supported. */
export function flattenEiaSeriesExport(text: string): EiaRow[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error('EIA SeriesExport: expected a JSON array of series');
  const out: EiaRow[] = [];
  for (const s of parsed as EiaSeries[]) {
    for (const k of ['series_id', 'iso', 'unit', 'productid', 'activityid'] as const) {
      if (typeof s?.[k] !== 'string' || !s[k]) throw new Error(`EIA SeriesExport: series without "${k}": ${JSON.stringify(s?.series_id ?? s).slice(0, 80)}`);
    }
    if (s.frequency !== 'A') throw new Error(`EIA SeriesExport: ${s.series_id} has frequency "${s.frequency}"; only annual (A) is supported`);
    if (!Array.isArray(s.data)) throw new Error(`EIA SeriesExport: ${s.series_id} has no data array`);
    for (const d of s.data) {
      const t = new Date(d.date);
      if (!Number.isFinite(t.getTime()) || t.getUTCMonth() !== 0 || t.getUTCDate() !== 1) {
        throw new Error(`EIA SeriesExport: ${s.series_id} has a non-annual date ${d.date}`);
      }
      const p = parseEiaValue(d.value);
      out.push({
        series_id: s.series_id, name: s.name, productid: s.productid, activityid: s.activityid, iso: s.iso, unit: s.unit,
        year: t.getUTCFullYear(), value: p.value,
        ...(p.flag ? { flag: p.flag } : {}), ...(p.marker ? { marker: p.marker } : {}),
      });
    }
  }
  return out;
}

/**
 * Export time written in a SeriesExport filename ("...SeriesExport-MM-DD-YYYY-HH-MM-SS.json"),
 * returned as "YYYY-MM-DD HH:MM:SS" exactly as written (no timezone conversion). null if absent.
 */
export function eiaExportStamp(path: string): string | null {
  const m = /SeriesExport-(\d{2})-(\d{2})-(\d{4})-(\d{2})-(\d{2})-(\d{2})\.json$/.exec(path);
  return m ? `${m[3]}-${m[1]}-${m[2]} ${m[4]}:${m[5]}:${m[6]}` : null;
}
