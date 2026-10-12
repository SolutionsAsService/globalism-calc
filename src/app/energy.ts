/**
 * UI for categories whose datasets carry a `view` (group × flow), e.g. the Energy tab:
 * group/flow picker, per-entity balance table, electricity panel (import exposure breakdown, generation mix),
 * trend charts (lines, or stacked areas for generation by source) and a source/attribution card.
 */
import { scaleLinear } from 'd3-scale';
import { el, fmtValue } from './format';
import { eiaExportStamp } from '../lib/eia';
import type { IndicatorScores } from '../lib/scoring';
import type { Dataset, ExposureEntry } from '../lib/types';

export interface ViewGroup { id: string; label: string; order: number; flows: IndicatorScores[] }

const FLOW_ORDER = ['imports', 'exports', 'net-imports', 'consumption', 'net-import-share'];
const FLOW_COLOR: Record<string, string> = { imports: '#e8590c', exports: '#1c7ed6', 'net-imports': '#7048e8', consumption: '#2b8a3e', 'net-import-share': '#c2255c' };
const flowRank = (i: IndicatorScores) => { const v = i.dataset.view!; if (v.flowOrder !== undefined) return v.flowOrder; const r = FLOW_ORDER.indexOf(v.flow); return r < 0 ? 99 : r; };
const TRIO = ['imports', 'exports', 'net-imports'];

/** Dataset ids used by the electricity panel (Ember/EI via Our World in Data, plus the derived exposure). */
export const ELECTRICITY = {
  exposure: 'electricity-import-exposure',
  generation: 'owid-electricity-generation',
  demand: 'owid-electricity-demand',
  netImports: 'owid-electricity-net-imports',
  netShare: 'owid-electricity-net-import-share',
  fossil: 'owid-electricity-fossil-share',
  lowCarbon: 'owid-electricity-low-carbon-share',
  perCapita: 'owid-electricity-demand-per-capita',
  mixGroup: 'electricity-mix',
} as const;

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
  for (const g of out) g.flows.sort((a, b) => flowRank(a) - flowRank(b));
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

const pct = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const pctText = (v: number | null | undefined) => (v == null ? '—' : pct.format(v) + '%');

// ---------- picker ----------
/** Group select + flow buttons. With `score`, a leading "Score" button shows the category score (no flow pressed). */
export function picker(inds: IndicatorScores[], current: IndicatorScores, onPick: (id: string) => void,
  score?: { active: boolean; onScore: () => void }): HTMLElement {
  const groups = groupsOf(inds);
  const cur = current.dataset.view!;
  const group = groups.find((g) => g.id === cur.group) ?? groups[0];
  const scoreActive = !!score?.active;
  const fuel = el('select', {
    id: 'fuel-select',
    onchange: (ev: Event) => {
      const g = groups.find((x) => x.id === (ev.target as HTMLSelectElement).value)!;
      const same = g.flows.find((f) => f.dataset.view!.flow === cur.flow);
      onPick((same ?? g.flows[0]).dataset.id);
    },
  }, ...groups.map((g) => el('option', { value: g.id, selected: g.id === group.id }, g.label)));
  const flows = el('div', { class: 'seg', role: 'group', 'aria-label': 'Series' },
    ...group.flows.map((f) => el('button', {
      type: 'button', class: 'seg-btn', id: `flow-${f.dataset.view!.flow}`, 'aria-pressed': String(!scoreActive && f === current),
      title: f.dataset.indicator.name, onclick: () => onPick(f.dataset.id),
    }, f.dataset.view!.flowLabel)));
  return el('div', { class: 'energy-picker' },
    score ? el('button', { type: 'button', class: 'seg-btn score-btn', id: 'show-score', 'aria-pressed': String(scoreActive), onclick: score.onScore }, 'Score (0–100)') : null,
    el('label', { class: 'inline-field', for: 'fuel-select' }, 'Show: '), fuel, flows);
}

// ---------- balance table (detail panel) ----------
const compactNum = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const plainNum = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
/** TWh with enough digits for small systems (0.03 TWh, not "0 TWh"). */
const twh = (v: number) => (Math.abs(v) > 0 && Math.abs(v) < 10 ? new Intl.NumberFormat('en', { maximumSignificantDigits: 2 }).format(v) : plainNum.format(v)) + ' TWh';
/** Narrow-column number: compact from 10,000 up (33,637.6 -> 33.6K); the full value is in the title tooltip. */
const narrow = (v: number) => (Math.abs(v) >= 1e4 ? compactNum.format(v) : plainNum.format(v));
/** Imports / exports / net per fuel, for groups that have trade flows (EIA). */
export function balanceTable(inds: IndicatorScores[], key: string): HTMLElement | null {
  const groups = groupsOf(inds).filter((g) => g.flows.some((f) => TRIO.includes(f.dataset.view!.flow) && !f.dataset.view!.chartSet));
  if (!groups.length) return null;
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
    const trio = TRIO.map(by);
    const years = new Set(trio.filter(Boolean).map((i) => (i!.raw.get(key) != null ? i!.years.get(key) : undefined)).filter((y) => y !== undefined));
    const oneYear = years.size === 1 ? [...years][0] : undefined;
    const unit = (trio.find(Boolean) ?? g.flows[0]).dataset.indicator.unit;
    tbody.append(el('tr', {},
      el('th', { scope: 'row' }, g.label, el('div', { class: 'small muted' }, unit, oneYear ? ` · ${oneYear}` : '')),
      ...trio.map((i) => cell(i, years.size > 1))));
    for (const extra of g.flows.filter((f) => !TRIO.includes(f.dataset.view!.flow))) {
      tbody.append(el('tr', { class: 'sub' },
        el('th', { scope: 'row', class: 'sub' }, extra.dataset.view!.flowLabel),
        el('td', { colspan: 3, class: 'num' + (extra.raw.get(key) == null ? ' missing' : '') }, valueText(extra, key),
          extra.raw.get(key) != null && extra.years.get(key) ? el('span', { class: 'yr' }, String(extra.years.get(key))) : null)));
    }
  }
  return el('div', { class: 'table-wrap balance-wrap' },
    el('table', { class: 'balance' },
      el('caption', { class: 'sr-only' }, 'Energy imports, exports and net imports by fuel (EIA)'),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Fuel trade (EIA)'), el('th', { scope: 'col', class: 'num' }, 'Imports'), el('th', { scope: 'col', class: 'num' }, 'Exports'), el('th', { scope: 'col', class: 'num' }, 'Net'))),
      tbody));
}

// ---------- charts ----------
interface Line { label: string; color: string; dash?: boolean; stack?: boolean; start: number; values: (number | null)[]; flags?: Record<string, string> }

function seriesLine(ind: IndicatorScores, key: string): Line | null {
  const s = ind.dataset.series;
  const values = s?.values[key];
  if (!s || !values) return null;
  const v = ind.dataset.view;
  const flow = v?.flow ?? '';
  return { label: v?.flowLabel ?? ind.dataset.indicator.name, color: v?.color ?? FLOW_COLOR[flow] ?? '#495057', dash: flow === 'net-imports' || flow === 'demand',
    stack: !!v?.stack, start: s.start, values, flags: s.flags?.[key] };
}

const tickFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...kids: (SVGElement | string)[]): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const c of kids) n.append(c);
  return n;
}

/**
 * Line chart; lines with `stack` are drawn as stacked areas first (only years where every stacked series has a number:
 * a year with any gap is left blank, never filled with 0). Other lines are drawn on top.
 */
export function lineChart(lines: Line[], unit: string, ariaLabel: string, size: { W: number; H: number } = { W: 640, H: 240 }): SVGSVGElement {
  const { W, H } = size;
  const m = { l: 56, r: 14, t: 12, b: 26 };
  const start = Math.min(...lines.map((l) => l.start));
  const end = Math.max(...lines.map((l) => l.start + l.values.length - 1));
  const at = (l: Line, yr: number) => l.values[yr - l.start] ?? null;
  const stacked = lines.filter((l) => l.stack);
  const plain = lines.filter((l) => !l.stack);
  const totals: (number | null)[] = [];
  for (let yr = start; yr <= end; yr++) {
    const vs = stacked.map((l) => at(l, yr));
    totals.push(stacked.length && vs.every((v) => v != null) ? (vs as number[]).reduce((a, b) => a + Math.max(0, b), 0) : null);
  }
  const all = [...plain.flatMap((l) => l.values.filter((v): v is number => v != null)), ...totals.filter((v): v is number => v != null)];
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
  if (stacked.length) {
    // Contiguous runs of complete years.
    const runs: [number, number][] = [];
    for (let yr = start; yr <= end; yr++) {
      if (totals[yr - start] == null) continue;
      const last = runs[runs.length - 1];
      if (last && last[1] === yr - 1) last[1] = yr; else runs.push([yr, yr]);
    }
    for (const [a, b] of runs) {
      const base = new Map<number, number>();
      for (let yr = a; yr <= b; yr++) base.set(yr, 0);
      for (const l of stacked) {
        const top: [number, number][] = [], bottom: [number, number][] = [];
        for (let yr = a; yr <= b; yr++) {
          const b0 = base.get(yr)!;
          const b1 = b0 + Math.max(0, at(l, yr) as number);
          bottom.push([x(yr), y(b0)]); top.push([x(yr), y(b1)]);
          base.set(yr, b1);
        }
        if (a === b) { // single year: a thin bar
          const [[px, py1]] = top; const [[, py0]] = bottom;
          root.append(svg('rect', { x: px - 3, y: py1, width: 6, height: Math.max(0, py0 - py1), fill: l.color, class: 'stack-area' }));
          continue;
        }
        const d = 'M' + top.map(([px, py]) => px.toFixed(1) + ',' + py.toFixed(1)).join('L') + 'L' + bottom.reverse().map(([px, py]) => px.toFixed(1) + ',' + py.toFixed(1)).join('L') + 'Z';
        root.append(svg('path', { d, fill: l.color, 'fill-opacity': 0.85, stroke: 'none', class: 'stack-area' }));
      }
    }
  }
  for (const l of plain) {
    let d = '';
    l.values.forEach((v, i) => {
      if (v == null) return;
      const prev = i > 0 ? l.values[i - 1] : null;
      d += `${prev == null ? 'M' : 'L'}${x(l.start + i).toFixed(1)},${y(v).toFixed(1)}`;
      const next = i < l.values.length - 1 ? l.values[i + 1] : null;
      if (prev == null && next == null) root.append(svg('circle', { cx: x(l.start + i), cy: y(v), r: 2.5, fill: l.color }));
    });
    root.append(svg('path', { d, fill: 'none', stroke: l.color, 'stroke-width': 2, class: 'trend-line', ...(l.dash ? { 'stroke-dasharray': '5 3' } : {}) }));
  }
  return root;
}

function legendRow(lines: Line[], extra?: string): HTMLElement {
  return el('div', { class: 'trend-legend' }, ...lines.map((l) => el('span', { class: 'key' },
    el('span', { class: 'swatch' + (l.dash ? ' dash' : '') + (l.stack ? ' area' : ''), style: `--c:${l.color}`, 'aria-hidden': 'true' }), l.label)),
    extra ? el('span', { class: 'muted small' }, extra) : null);
}

/** Flows drawn together with `current`: same chartSet (new-style groups) or the EIA convention (trade trio together). */
function chartMembers(group: ViewGroup, current: IndicatorScores): IndicatorScores[] {
  const v = current.dataset.view!;
  // Same axis: identical units, or percentages (each line's label says what it is a share of).
  const unit = current.dataset.indicator.unit;
  const sameAxis = (u: string) => u === unit || (u.startsWith('%') && unit.startsWith('%'));
  if (v.chartSet) return group.flows.filter((f) => f.dataset.view!.chartSet === v.chartSet && sameAxis(f.dataset.indicator.unit));
  return ['consumption', 'net-import-share'].includes(v.flow) ? [current] : group.flows.filter((f) => TRIO.includes(f.dataset.view!.flow));
}

export function trendCard(inds: IndicatorScores[], current: IndicatorScores, key: string | undefined, entityName: (k: string) => string): HTMLElement {
  const card = el('section', { class: 'card trend', 'aria-labelledby': 'trend-title' });
  const v = current.dataset.view;
  const group = groupsOf(inds).find((g) => g.id === v?.group);
  if (!key || !group) {
    card.append(el('h2', { id: 'trend-title' }, 'Trend'), el('p', { class: 'muted' }, 'Select a country or territory on the map or in the ranking to see its annual series.'));
    return card;
  }
  const members = chartMembers(group, current);
  const lines = members.map((f) => seriesLine(f, key)).filter((l): l is Line => !!l);
  const unit = current.dataset.indicator.unit;
  card.append(el('h2', { id: 'trend-title' }, `Trend: ${entityName(key)} · ${group.label}`));
  if (!lines.length) {
    card.append(el('p', { class: 'muted' }, `No annual values for ${entityName(key)} in these series.`));
    return card;
  }
  const start = Math.min(...lines.map((l) => l.start));
  const end = Math.max(...lines.map((l) => l.start + l.values.length - 1));
  card.append(legendRow(lines, unitText(current.dataset)),
    lineChart(lines, unit, `${group.label} ${lines.map((l) => l.label.toLowerCase()).join(', ')} for ${entityName(key)}, ${start}–${end}, in ${unit}`));
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
  const eia = members.some((f) => f.dataset.import.from.includes('/eia/'));
  card.append(el('p', { class: 'small muted' }, eia
    ? 'Gaps are years where EIA has no number ("--", "NA" or "ie"); they are not drawn as 0.'
    : 'Gaps are years where the source has no number; they are not drawn as 0. Stacked areas are only drawn for years where every source has a value.'));
  return card;
}

// ---------- electricity panel (detail) ----------
function latestAt(ind: IndicatorScores | undefined, key: string, year: number): number | null {
  const s = ind?.dataset.series;
  const arr = s?.values[key];
  if (!s || !arr || year < s.start || year > s.end) return null;
  return arr[year - s.start] ?? null;
}

const PART_COLOR: Record<string, string> = { direct: '#e8590c', coal: '#343a40', gas: '#f59f00', oil: '#8d5524' };

function exposureBlock(ind: IndicatorScores, key: string): HTMLElement {
  const d = ind.dataset;
  const e: ExposureEntry | undefined = d.breakdown?.byKey[key];
  const box = el('div', { class: 'elec-block', id: 'exposure-block' });
  const v = ind.raw.get(key) ?? null;
  box.append(el('div', { class: 'elec-head' }, el('span', { class: 'ind-name' }, d.indicator.name, d.scoring.include ? el('span', { class: 'badge status-scored' }, 'scored') : el('span', { class: 'badge' }, 'context only')),
    el('strong', { class: 'elec-big' }, v != null ? pctText(v) : e ? `${pctText(e.low)}–${pctText(e.high)}` : '—'),
    el('span', { class: 'small muted' }, e ? String(e.year) : '')));
  if (!e) {
    box.append(el('p', { class: 'small muted' }, 'No electricity generation and trade data for this entity.'));
    return box;
  }
  const parts = d.breakdown!.parts;
  const segs: { id: string; label: string; v: number }[] = [{ id: 'direct', label: 'Net electricity imports', v: e.direct },
    ...parts.map((p) => ({ id: p.id, label: `Imported ${p.label.toLowerCase()}`, v: e.parts[p.id]?.contribution ?? 0 }))];
  const unknown = e.high - e.low;
  box.append(el('div', { class: 'stackbar', role: 'img', 'aria-label': `Import exposure breakdown: ${segs.map((s) => `${s.label} ${pctText(s.v)}`).join(', ')}${unknown > 0 ? `, unknown ${pctText(unknown)}` : ''}` },
    ...segs.filter((s) => s.v > 0).map((s) => el('span', { class: 'stackbar-seg', style: `width:${s.v}%;background:${PART_COLOR[s.id] ?? '#868e96'}`, title: `${s.label}: ${pctText(s.v)}` })),
    unknown > 0 ? el('span', { class: 'stackbar-seg unknown', style: `width:${unknown}%`, title: `Unknown (fuel import dependence missing): up to ${pctText(unknown)}` }) : null));
  const tbody = el('tbody');
  tbody.append(el('tr', {}, el('th', { scope: 'row' }, el('span', { class: 'chip-dot', style: `background:${PART_COLOR.direct}` }), 'Net electricity imports'),
    el('td', { class: 'num' }, pctText(e.direct)), el('td', { class: 'num muted' }, '100%'), el('td', { class: 'num' }, pctText(e.direct))));
  let fuelShare = 0;
  for (const p of parts) {
    const x = e.parts[p.id];
    if (!x) continue;
    fuelShare += x.share;
    tbody.append(el('tr', {}, el('th', { scope: 'row' }, el('span', { class: 'chip-dot', style: `background:${PART_COLOR[p.id] ?? '#868e96'}` }), `${p.label} power`),
      el('td', { class: 'num' }, pctText(x.share)),
      el('td', { class: 'num' + (x.dependence == null ? ' missing' : '') }, x.dependence == null ? (x.share === 0 ? 'not needed' : 'missing') : pctText(x.dependence)),
      el('td', { class: 'num' + (x.contribution == null ? ' missing' : '') }, x.contribution == null ? '?' : pctText(x.contribution))));
  }
  const rest = Math.max(0, 100 - e.direct - fuelShare);
  tbody.append(el('tr', { class: 'sub' }, el('th', { scope: 'row', class: 'sub' }, 'Nuclear, renewables & other'), el('td', { class: 'num' }, pctText(rest)), el('td', { class: 'num muted' }, 'not counted'), el('td', { class: 'num' }, '0%')));
  box.append(el('div', { class: 'table-wrap balance-wrap' }, el('table', { class: 'balance exposure-table' },
    el('caption', { class: 'sr-only' }, 'Electricity import exposure breakdown'),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, `Supply, ${e.year}`), el('th', { scope: 'col', class: 'num', title: 'Share of electricity supply' }, 'Share'), el('th', { scope: 'col', class: 'num', title: 'Net import dependence of the fuel (economy-wide)' }, 'Imported'), el('th', { scope: 'col', class: 'num', title: 'Share × imported' }, 'Exposed'))),
    tbody)));
  if (!e.exact) {
    const miss = parts.filter((p) => e.parts[p.id]?.contribution == null).map((p) => p.label.toLowerCase());
    box.append(el('p', { class: 'small caveat', role: 'note' }, `Not computed: no import-dependence data for ${miss.join(' and ')} (the Energy Institute does not list this country separately). Bounds: ${pctText(e.low)} if that fuel were all domestic, ${pctText(e.high)} if all imported. Not scored.`));
  }
  box.append(el('p', { class: 'small muted' }, 'Fuel imported = economy-wide net import dependence of the fuel (EI). Nuclear fuel is not counted (no uranium data). ', el('a', { href: '#/method' }, 'Formula & limits')));
  return box;
}

function mixBlock(inds: IndicatorScores[], key: string): HTMLElement | null {
  const group = groupsOf(inds).find((g) => g.id === ELECTRICITY.mixGroup);
  if (!group) return null;
  const sources = group.flows.filter((f) => f.dataset.view!.stack);
  const total = group.flows.find((f) => f.dataset.id === ELECTRICITY.generation);
  // Latest year in which every source has a value.
  let year: number | undefined;
  const s0 = sources[0]?.dataset.series;
  if (s0) for (let y = s0.end; y >= s0.start; y--) if (sources.every((f) => latestAt(f, key, y) != null)) { year = y; break; }
  const box = el('div', { class: 'elec-block', id: 'mix-block' });
  box.append(el('div', { class: 'elec-head' }, el('span', { class: 'ind-name' }, 'Generation mix'), el('span', { class: 'small muted' }, year ? String(year) : '')));
  if (year === undefined) { box.append(el('p', { class: 'small muted' }, 'No complete generation-by-source data.')); return box; }
  const vals = sources.map((f) => ({ f, v: latestAt(f, key, year!) as number }));
  const sum = vals.reduce((a, b) => a + b.v, 0);
  const tot = latestAt(total, key, year) ?? sum;
  if (!(sum > 0)) { box.append(el('p', { class: 'small muted' }, `No domestic generation in ${year} (${fmtValue(tot, 'TWh')}).`)); return box; }
  box.append(el('div', { class: 'stackbar', role: 'img', 'aria-label': 'Generation mix: ' + vals.filter((x) => x.v > 0).map((x) => `${x.f.dataset.view!.flowLabel} ${pct.format((100 * x.v) / sum)}%`).join(', ') },
    ...vals.filter((x) => x.v > 0).map((x) => el('span', { class: 'stackbar-seg', style: `width:${(100 * x.v) / sum}%;background:${x.f.dataset.view!.color}`, title: `${x.f.dataset.view!.flowLabel}: ${twh(x.v)} (${pct.format((100 * x.v) / sum)}%)` }))));
  box.append(el('ul', { class: 'mix-legend small' }, ...vals.filter((x) => x.v > 0).sort((a, b) => b.v - a.v).map((x) =>
    el('li', {}, el('span', { class: 'chip-dot', style: `background:${x.f.dataset.view!.color}` }), `${x.f.dataset.view!.flowLabel} ${pct.format((100 * x.v) / sum)}%`, el('span', { class: 'muted' }, ` · ${twh(x.v)}`)))));
  const lines = sources.map((f) => seriesLine(f, key)).filter((l): l is Line => !!l);
  const demand = group.flows.find((f) => f.dataset.id === ELECTRICITY.demand);
  const dl = demand ? seriesLine(demand, key) : null;
  if (lines.length) {
    box.append(legendRow(dl ? [dl] : [], 'Stacked: generation by source (TWh)'),
      lineChart([...lines, ...(dl ? [dl] : [])], 'TWh', 'Electricity generation by source over time, TWh' + (dl ? ', with demand' : ''), { W: 360, H: 180 }));
  }
  return box;
}

function factsBlock(inds: IndicatorScores[], key: string): HTMLElement {
  const by = (id: string) => inds.find((i) => i.dataset.id === id);
  const rows: [string, IndicatorScores | undefined][] = [
    ['Demand', by(ELECTRICITY.demand)], ['Generation', by(ELECTRICITY.generation)], ['Net imports', by(ELECTRICITY.netImports)],
    ['Net imports, % of demand', by(ELECTRICITY.netShare)], ['Fossil share of generation', by(ELECTRICITY.fossil)],
    ['Low-carbon share', by(ELECTRICITY.lowCarbon)], ['Demand per person', by(ELECTRICITY.perCapita)],
  ];
  const tbody = el('tbody');
  for (const [label, ind] of rows) {
    if (!ind) continue;
    const v = ind.raw.get(key) ?? null;
    tbody.append(el('tr', {}, el('th', { scope: 'row' }, label),
      el('td', { class: 'num' + (v == null ? ' missing' : '') }, ind.raw.has(key) ? valueText(ind, key) : '—', v != null ? el('span', { class: 'yr' }, String(ind.years.get(key))) : null)));
  }
  return el('div', { class: 'table-wrap balance-wrap' }, el('table', { class: 'balance facts-table' }, el('caption', { class: 'sr-only' }, 'Electricity key figures'), tbody));
}

/** Electricity block for the detail panel: import exposure breakdown, generation mix (bar + stacked chart), key figures. */
export function electricityPanel(inds: IndicatorScores[], key: string): HTMLElement | null {
  const exposure = inds.find((i) => i.dataset.id === ELECTRICITY.exposure);
  const hasMix = inds.some((i) => i.dataset.view?.group === ELECTRICITY.mixGroup);
  if (!exposure && !hasMix) return null;
  const box = el('div', { class: 'elec-panel', id: 'electricity-panel' }, el('h3', { class: 'elec-title' }, 'Electricity'));
  if (exposure) box.append(exposureBlock(exposure, key));
  const mix = mixBlock(inds, key);
  if (mix) box.append(mix);
  box.append(factsBlock(inds, key));
  const src = (exposure ?? inds.find((i) => i.dataset.view?.group === ELECTRICITY.mixGroup))!.dataset.source;
  box.append(el('div', { class: 'small muted' }, 'Ember (CC BY 4.0) and Energy Institute data via ', el('a', { href: src.url, target: '_blank', rel: 'noopener' }, 'Our World in Data'), '.'));
  return box;
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
      el('td', { class: 'wrap small' }, el('a', { href: d.source.url, target: '_blank', rel: 'noopener' }, d.source.name)),
      el('td', { class: 'wrap' }, derived ? el('span', { class: 'muted small', title: d.indicator.description ?? d.import.from }, 'Derived from ', el('code', {}, d.import.from.replace(/^derived: /, '')), ' (', el('a', { href: '#/method' }, 'formula'), ')')
        : el('span', {}, el('code', {}, file), d.indicator.code && !stamp ? el('span', { class: 'small muted' }, ' · column ', el('code', {}, d.indicator.code)) : null)),
      el('td', {}, stamp ? `${stamp} UTC (export)` : d.source.retrieved ? `${d.source.retrieved} (download)` : '—'),
      el('td', {}, d.series ? `${d.series.start}–${d.year}` : String(d.year)),
      el('td', {}, unitText(d)),
      el('td', { class: 'wrap small' }, d.source.sha256 ? el('code', { title: d.source.sha256 }, d.source.sha256.slice(0, 12) + '…') : '—'),
      el('td', { class: 'wrap small' }, markers || '—')));
  }
  const notes = [...new Set(list.flatMap((i) => [...(i.dataset.caveats ?? []).map((c) => '⚠ ' + c), ...(i.dataset.notes ?? [])]))];
  const sources = [...new Map(list.map((i) => [i.dataset.source.name.replace(/^Derived from /, ''), i.dataset.source])).values()].filter((s) => !s.name.startsWith('Derived'));
  const upstream = [...new Map(list.flatMap((i) => i.dataset.source.upstream ?? []).map((u) => [u.name, u])).values()];
  return el('section', { class: 'card', id: 'energy-sources', 'aria-labelledby': 'energy-sources-title' },
    el('h2', { id: 'energy-sources-title' }, 'Energy data sources'),
    el('ul', { class: 'small' }, ...sources.map((s) => el('li', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name), ` · ${s.license}`,
      s.downloadUrl ? el('span', { class: 'muted' }, ' · file ', el('code', {}, s.downloadUrl), s.lastModified ? `, Last-Modified ${s.lastModified}` : '', s.retrieved ? `, downloaded ${s.retrieved}` : '') : null)),
      ...upstream.map((u) => el('li', {}, 'Original producer: ', el('a', { href: u.url, target: '_blank', rel: 'noopener' }, u.name), ` · ${u.license}`))),
    el('p', { class: 'small muted' }, 'Raw files are kept unchanged in data/raw/eia/ (EIA exports; time from each filename) and data/raw/owid/ (with SHA-256 checked on every import).'),
    el('div', { class: 'table-wrap' }, el('table', { class: 'sources-table' },
      el('thead', {}, el('tr', {}, ...['Series', 'Source', 'File / column', 'Exported / downloaded', 'Years', 'Unit', 'SHA-256', 'Missing-value markers'].map((h) => el('th', { scope: 'col' }, h)))),
      tbody)),
    el('details', {}, el('summary', {}, `Notes & caveats (${notes.length})`), el('ul', { class: 'small notes' }, ...notes.map((n) => el('li', { class: n.startsWith('⚠') ? 'caveat' : '' }, n)))));
}
