/**
 * UI for categories whose datasets carry a `view` (group × flow), e.g. the Energy tab:
 * fuel/flow picker, per-entity balance table, trend chart from Dataset.series, and a source/attribution card.
 */
import { scaleLinear } from 'd3-scale';
import { el, fmtValue } from './format';
import { eiaExportStamp } from '../lib/eia';
import type { IndicatorScores } from '../lib/scoring';
import type { Dataset } from '../lib/types';

export interface ViewGroup { id: string; label: string; order: number; flows: IndicatorScores[] }

const FLOW_ORDER = ['imports', 'exports', 'net-imports', 'consumption', 'net-import-share'];
const FLOW_COLOR: Record<string, string> = { imports: '#e8590c', exports: '#1c7ed6', 'net-imports': '#7048e8', consumption: '#2b8a3e', 'net-import-share': '#c2255c' };
const flowRank = (f: string) => { const i = FLOW_ORDER.indexOf(f); return i < 0 ? 99 : i; };

export const hasViews = (inds: IndicatorScores[]) => inds.some((i) => i.dataset.view);

export function groupsOf(inds: IndicatorScores[]): ViewGroup[] {
  const m = new Map<string, ViewGroup>();
  for (const i of inds) {
    const v = i.dataset.view;
    if (!v) continue;
    const g = m.get(v.group) ?? { id: v.group, label: v.groupLabel, order: v.order, flows: [] };
    g.flows.push(i);
    m.set(v.group, g);
  }
  const out = [...m.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  for (const g of out) g.flows.sort((a, b) => flowRank(a.dataset.view!.flow) - flowRank(b.dataset.view!.flow));
  return out;
}

export function defaultIndicator(inds: IndicatorScores[]): IndicatorScores {
  return inds.find((i) => i.dataset.view?.default) ?? groupsOf(inds)[0]?.flows[0] ?? inds[0];
}

/** "TBPD (thousand barrels per day)" when the dataset spells its unit code out. */
export const unitText = (d: Dataset) => (d.indicator.unitLabel ? `${d.indicator.unit} (${d.indicator.unitLabel})` : d.indicator.unit);

export const FLAG_TITLE: Record<string, string> = { p: 'EIA flag "p" on this value (likely preliminary)' };

/** Value with unit, plus the source flag in brackets, e.g. "22 BKWH (p)". */
export function valueText(ind: IndicatorScores, key: string): string {
  if (!ind.raw.has(key)) return 'not in dataset';
  const v = ind.raw.get(key) ?? null;
  const f = ind.flags.get(key);
  return fmtValue(v, ind.dataset.indicator.unit) + (f && v != null ? ` (${f})` : '');
}

// ---------- picker ----------
export function picker(inds: IndicatorScores[], current: IndicatorScores, onPick: (id: string) => void): HTMLElement {
  const groups = groupsOf(inds);
  const cur = current.dataset.view!;
  const group = groups.find((g) => g.id === cur.group) ?? groups[0];
  const fuel = el('select', {
    id: 'fuel-select',
    onchange: (ev: Event) => {
      const g = groups.find((x) => x.id === (ev.target as HTMLSelectElement).value)!;
      const same = g.flows.find((f) => f.dataset.view!.flow === cur.flow);
      onPick((same ?? g.flows[0]).dataset.id);
    },
  }, ...groups.map((g) => el('option', { value: g.id, selected: g.id === group.id }, g.label)));
  const flows = el('div', { class: 'seg', role: 'group', 'aria-label': 'Flow' },
    ...group.flows.map((f) => el('button', {
      type: 'button', class: 'seg-btn', id: `flow-${f.dataset.view!.flow}`, 'aria-pressed': String(f === current),
      title: f.dataset.indicator.name, onclick: () => onPick(f.dataset.id),
    }, f.dataset.view!.flowLabel)));
  return el('div', { class: 'energy-picker' },
    el('label', { class: 'inline-field', for: 'fuel-select' }, 'Fuel: '), fuel, flows);
}

// ---------- balance table (detail panel) ----------
const compactNum = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const plainNum = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
/** Narrow-column number: compact from 10,000 up (33,637.6 -> 33.6K); the full value is in the title tooltip. */
const narrow = (v: number) => (Math.abs(v) >= 1e4 ? compactNum.format(v) : plainNum.format(v));
export function balanceTable(inds: IndicatorScores[], key: string): HTMLElement {
  const groups = groupsOf(inds);
  const tbody = el('tbody');
  const cell = (ind: IndicatorScores | undefined, showYear: boolean) => {
    if (!ind) return el('td', { class: 'num muted', title: 'No dataset for this flow' }, '·');
    const v = ind.raw.get(key) ?? null;
    const f = ind.flags.get(key);
    const y = ind.years.get(key);
    return el('td', { class: 'num' + (v == null ? ' missing' : ''), title: v != null ? fmtValue(v, ind.dataset.indicator.unit) + (y ? ` (${y})` : '') : undefined },
      !ind.raw.has(key) ? '—' : v == null ? 'missing' : narrow(v),
      f && v != null ? el('abbr', { class: 'flag', title: FLAG_TITLE[f] ?? `Source flag "${f}"` }, f) : null,
      showYear && y && v != null ? el('span', { class: 'yr' }, String(y)) : null);
  };
  for (const g of groups) {
    const by = (flow: string) => g.flows.find((f) => f.dataset.view!.flow === flow);
    const trio = [by('imports'), by('exports'), by('net-imports')];
    const years = new Set(trio.filter(Boolean).map((i) => (i!.raw.get(key) != null ? i!.years.get(key) : undefined)).filter((y) => y !== undefined));
    const oneYear = years.size === 1 ? [...years][0] : undefined;
    const unit = (trio.find(Boolean) ?? g.flows[0]).dataset.indicator.unit;
    tbody.append(el('tr', {},
      el('th', { scope: 'row' }, g.label, el('div', { class: 'small muted' }, unit, oneYear ? ` · ${oneYear}` : '')),
      ...trio.map((i) => cell(i, years.size > 1))));
    for (const extra of g.flows.filter((f) => !['imports', 'exports', 'net-imports'].includes(f.dataset.view!.flow))) {
      tbody.append(el('tr', { class: 'sub' },
        el('th', { scope: 'row', class: 'sub' }, extra.dataset.view!.flowLabel),
        el('td', { colspan: 3, class: 'num' + (extra.raw.get(key) == null ? ' missing' : '') }, valueText(extra, key),
          extra.raw.get(key) != null && extra.years.get(key) ? el('span', { class: 'yr' }, String(extra.years.get(key))) : null)));
    }
  }
  return el('div', { class: 'table-wrap balance-wrap' },
    el('table', { class: 'balance' },
      el('caption', { class: 'sr-only' }, 'Energy imports, exports and net imports by fuel'),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Fuel'), el('th', { scope: 'col', class: 'num' }, 'Imports'), el('th', { scope: 'col', class: 'num' }, 'Exports'), el('th', { scope: 'col', class: 'num' }, 'Net'))),
      tbody));
}

// ---------- trend chart ----------
interface Line { label: string; color: string; dash?: boolean; start: number; values: (number | null)[]; flags?: Record<string, string> }

function seriesLine(ind: IndicatorScores, key: string): Line | null {
  const s = ind.dataset.series;
  const values = s?.values[key];
  if (!s || !values) return null;
  const flow = ind.dataset.view?.flow ?? '';
  return { label: ind.dataset.view?.flowLabel ?? ind.dataset.indicator.name, color: FLOW_COLOR[flow] ?? '#495057', dash: flow === 'net-imports', start: s.start, values, flags: s.flags?.[key] };
}

const tickFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...kids: (SVGElement | string)[]): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const c of kids) n.append(c);
  return n;
}

export function lineChart(lines: Line[], unit: string, ariaLabel: string): SVGSVGElement {
  const W = 640, H = 240, m = { l: 56, r: 14, t: 12, b: 26 };
  const start = Math.min(...lines.map((l) => l.start));
  const end = Math.max(...lines.map((l) => l.start + l.values.length - 1));
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v != null));
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const x = scaleLinear().domain([start, Math.max(end, start + 1)]).range([m.l, W - m.r]);
  const y = scaleLinear().domain([lo, hi === lo ? lo + 1 : hi]).nice(5).range([H - m.b, m.t]);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend-svg', role: 'img', 'aria-label': ariaLabel });
  for (const t of y.ticks(5)) {
    root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'axis-zero' : 'grid' }));
    root.append(svg('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, tickFmt.format(t)));
  }
  const step = end - start > 30 ? 10 : 5;
  for (let yr = Math.ceil(start / step) * step; yr <= end; yr += step) {
    root.append(svg('text', { x: x(yr), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, String(yr)));
  }
  root.append(svg('text', { x: m.l, y: m.t - 2, class: 'tick unit' }, unit));
  for (const l of lines) {
    let d = '';
    l.values.forEach((v, i) => {
      if (v == null) return;
      const prev = i > 0 ? l.values[i - 1] : null;
      d += `${prev == null ? 'M' : 'L'}${x(l.start + i).toFixed(1)},${y(v).toFixed(1)}`;
      const next = i < l.values.length - 1 ? l.values[i + 1] : null;
      if (prev == null && next == null) root.append(svg('circle', { cx: x(l.start + i), cy: y(v), r: 2.5, fill: l.color }));
    });
    root.append(svg('path', { d, fill: 'none', stroke: l.color, 'stroke-width': 2, ...(l.dash ? { 'stroke-dasharray': '5 3' } : {}) }));
  }
  return root;
}

export function trendCard(inds: IndicatorScores[], current: IndicatorScores, key: string | undefined, entityName: (k: string) => string): HTMLElement {
  const card = el('section', { class: 'card trend', 'aria-labelledby': 'trend-title' });
  const v = current.dataset.view;
  const group = groupsOf(inds).find((g) => g.id === v?.group);
  if (!key || !group) {
    card.append(el('h2', { id: 'trend-title' }, 'Trend'), el('p', { class: 'muted' }, 'Select a country or territory on the map or in the ranking to see its annual series for this fuel.'));
    return card;
  }
  // Same-unit lines only: trade flows together; consumption or the % share on their own.
  const flow = v!.flow;
  const members = ['consumption', 'net-import-share'].includes(flow) ? [current] : group.flows.filter((f) => ['imports', 'exports', 'net-imports'].includes(f.dataset.view!.flow));
  const lines = members.map((f) => seriesLine(f, key)).filter((l): l is Line => !!l);
  const unit = current.dataset.indicator.unit;
  card.append(el('h2', { id: 'trend-title' }, `Trend: ${entityName(key)} · ${group.label}`));
  if (!lines.length) {
    card.append(el('p', { class: 'muted' }, `No annual values for ${entityName(key)} in these series.`));
    return card;
  }
  const start = Math.min(...lines.map((l) => l.start));
  const end = Math.max(...lines.map((l) => l.start + l.values.length - 1));
  card.append(
    el('div', { class: 'trend-legend' }, ...lines.map((l) => el('span', { class: 'key' }, el('span', { class: 'swatch' + (l.dash ? ' dash' : ''), style: `--c:${l.color}`, 'aria-hidden': 'true' }), l.label)),
      el('span', { class: 'muted small' }, unitText(current.dataset))),
    lineChart(lines, unit, `${group.label} ${lines.map((l) => l.label.toLowerCase()).join(', ')} for ${entityName(key)}, ${start}–${end}, in ${unit}`),
  );
  // Accessible values table (also the exact numbers behind the chart).
  const tbody = el('tbody');
  for (let yr = end; yr >= start; yr--) {
    const vals = lines.map((l) => l.values[yr - l.start] ?? null);
    if (vals.every((x) => x == null)) continue;
    tbody.append(el('tr', {}, el('th', { scope: 'row' }, String(yr)),
      ...lines.map((l, i) => el('td', { class: 'num' + (vals[i] == null ? ' missing' : '') }, vals[i] == null ? 'missing' : fmtValue(vals[i], '').trim() + (l.flags?.[String(yr)] ? ` (${l.flags[String(yr)]})` : '')))));
  }
  card.append(el('details', {}, el('summary', {}, 'Show values'),
    el('div', { class: 'table-wrap' }, el('table', { class: 'trend-table' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Year'), ...lines.map((l) => el('th', { scope: 'col', class: 'num' }, `${l.label} (${unit})`)))), tbody))));
  card.append(el('p', { class: 'small muted' }, 'Gaps are years where EIA has no number ("--", "NA" or "ie"); they are not drawn as 0.'));
  return card;
}

// ---------- sources ----------
export function sourcesCard(inds: IndicatorScores[]): HTMLElement {
  const groups = groupsOf(inds);
  const list = groups.flatMap((g) => g.flows);
  const tbody = el('tbody');
  for (const i of list) {
    const d = i.dataset;
    const derived = d.import.from.startsWith('derived:');
    const file = derived ? '' : d.import.from.split('/').pop()!;
    const stamp = derived ? null : eiaExportStamp(file);
    const markers = Object.entries(d.import.markers ?? {}).map(([k, n]) => `${k} ×${n}`).join(', ');
    tbody.append(el('tr', {},
      el('td', {}, d.view!.groupLabel, ' · ', d.view!.flowLabel),
      el('td', { class: 'wrap' }, derived ? el('span', { class: 'muted' }, 'Derived: ', d.indicator.description ?? d.import.from) : el('code', {}, file)),
      el('td', {}, stamp ? `${stamp} UTC` : '—'),
      el('td', {}, d.series ? `${d.series.start}–${d.year}` : String(d.year)),
      el('td', {}, unitText(d)),
      el('td', { class: 'wrap small' }, markers || '—')));
  }
  const notes = [...new Set(list.flatMap((i) => [...(i.dataset.caveats ?? []).map((c) => '⚠ ' + c), ...(i.dataset.notes ?? [])]))];
  const first = list[0]?.dataset.source;
  return el('section', { class: 'card', id: 'energy-sources', 'aria-labelledby': 'energy-sources-title' },
    el('h2', { id: 'energy-sources-title' }, 'Energy data sources'),
    first ? el('p', { class: 'small' }, 'Source: ', el('a', { href: first.url, target: '_blank', rel: 'noopener' }, first.name), ` · ${first.license}. Raw exports are kept unchanged in data/raw/eia/; the export time comes from each filename.`) : null,
    el('div', { class: 'table-wrap' }, el('table', { class: 'sources-table' },
      el('thead', {}, el('tr', {}, ...['Series', 'EIA export file', 'Exported', 'Years', 'Unit (as stated by EIA)', 'Missing-value markers'].map((h) => el('th', { scope: 'col' }, h)))),
      tbody)),
    el('details', {}, el('summary', {}, `Notes & caveats (${notes.length})`), el('ul', { class: 'small notes' }, ...notes.map((n) => el('li', { class: n.startsWith('⚠') ? 'caveat' : '' }, n)))));
}
