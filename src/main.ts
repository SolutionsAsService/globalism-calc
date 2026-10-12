import './styles.css';
import { scaleSequential, scaleSequentialLog, scaleSequentialSymlog, scaleDivergingSymlog } from 'd3-scale';
import { interpolateYlOrRd, interpolateBlues, interpolateRdBu } from 'd3-scale-chromatic';
import { balanceTable, defaultIndicator, FLAG_TITLE, hasViews, picker, sourcesCard, trendCard, unitText, valueText } from './app/energy';
import { loadModel, compositeFor, hasAnyRow, type Model } from './app/model';
import { createMap, legend, type Metric, type MapView } from './app/map';
import { el, fmtScore, fmtValue, typeLabel } from './app/format';
import { describeScoring, type IndicatorScores } from './lib/scoring';
import { parseHash, toHash, loadWeights, saveWeights, type State } from './app/state';
import type { Entity } from './lib/types';

const root = document.getElementById('app')!;
let M: Model;
let S: State;
let defaultWeights: Record<string, number> = {};

const scoreColor = scaleSequential(interpolateYlOrRd).domain([0, 100]);
const COMPOSITE_FORMULA = 'Composite dependence = Σ(wᶜ × sᶜ) ÷ Σ(wᶜ), over categories c that have a score for this entity and weight wᶜ > 0. Missing categories are excluded, never counted as 0. Self-sufficiency = 100 − dependence.';

// ---------- helpers ----------
const catLabel = (id: string) => (id === 'composite' ? 'Composite' : M.categories.find((c) => c.id === id)?.label ?? id);
const entityName = (key: string) => M.byKey.get(key)?.name ?? key;
const statusText = { scored: 'scored', context: 'context only', needed: 'data needed' } as const;

function navigate(patch: Partial<State>) {
  S = { ...S, ...patch };
  const h = toHash(S);
  if (location.hash !== h) location.hash = h; // triggers hashchange -> render
  else render();
}

function fromHash() {
  const p = parseHash(location.hash);
  S = { ...S, cat: 'composite', indicator: undefined, selected: undefined, ...p, compare: p.compare ?? S.compare };
  if (S.cat !== 'composite' && !M.categories.some((c) => c.id === S.cat)) S.cat = 'composite';
  if (S.selected && !M.byKey.has(S.selected)) S.selected = undefined;
  S.compare = S.compare.filter((k) => M.byKey.has(k));
}

const samples = (f: (t: number) => string) => Array.from({ length: 11 }, (_, i) => f(i / 10));
/** symlog with constant 1: sign(x) · log(1 + |x|). */
const symlog = (x: number) => Math.sign(x) * Math.log1p(Math.abs(x));
const symexp = (y: number) => Math.sign(y) * Math.expm1(Math.abs(y));

function rawMetric(ind: IndicatorScores): Metric {
  const d = ind.dataset;
  const { unit, name } = d.indicator;
  const vals = [...ind.raw.values()].filter((v): v is number => v != null);
  const min = Math.min(...vals), max = Math.max(...vals);
  const fmt = (v: number) => fmtValue(v, unit);
  const years = new Set([...ind.raw].filter(([, v]) => v != null).map(([k]) => ind.years.get(k)));
  const yearText = years.size > 1 ? `latest year per entity, up to ${d.year}` : String(d.year);
  const scoreText = d.scoring.include ? 'Score: ' + describeScoring(d.scoring, unit) : `Not used in any score${d.scoring.rationale ? ': ' + d.scoring.rationale : '.'}`;
  const base = {
    kind: 'raw' as const, unit, get: (k: string) => ind.raw.get(k) ?? null, domain: [min, max] as [number, number],
    yearOf: (k: string) => ind.years.get(k), flagOf: (k: string) => ind.flags.get(k),
    formula: `${d.indicator.description && d.import.from.startsWith('derived:') ? d.indicator.description + ' ' : ''}Raw value from ${d.source.name}, ${yearText}. ${scoreText}`,
  };
  if (min < 0 && max > 0) {
    // Net flows: diverging around 0 (red = net importer, blue = net exporter), symlog so a few giants don't wash out the rest.
    const interp = (t: number) => interpolateRdBu(1 - t);
    const scale = scaleDivergingSymlog(interp).domain([min, 0, max]);
    return { ...base, label: `${name} (${unitText(d)}; red = net importer, blue = net exporter; symmetric log scale)`,
      color: (v) => scale(v), gradient: samples(interp), ticks: [min, 0, max].map((v) => ({ v, label: fmt(v) })) };
  }
  if (min >= 0 && max > 0 && min === 0 && vals.some((v) => v > 0 && max / v > 1000)) {
    // Heavy-tailed with zeros (most countries import little, a few import a lot): symlog keeps 0 and small values visible.
    const scale = scaleSequentialSymlog(interpolateBlues).domain([0, max]);
    const mid = symexp(symlog(max) / 2);
    return { ...base, label: `${name} (${unitText(d)}, raw value, symmetric log scale)`, color: (v) => scale(v),
      gradient: samples(interpolateBlues), ticks: [0, mid, max].map((v) => ({ v, label: fmt(v) })) };
  }
  const useLog = min > 0 && max / min > 1000;
  const scale = useLog ? scaleSequentialLog(interpolateBlues).domain([min, max]) : scaleSequential(interpolateBlues).domain([min, max]);
  const ticks = useLog
    ? [min, Math.sqrt(min * max), max].map((v) => ({ v, label: fmt(v) }))
    : [min, (min + max) / 2, max].map((v) => ({ v, label: fmt(v) }));
  return { ...base, label: `${name} (${unitText(d)}, raw value${useLog ? ', log scale' : ''})`, color: (v) => scale(v), ticks };
}

/** The dataset shown for a category when no indicator is chosen (and the category has no score). */
function shownIndicator(cat: string): IndicatorScores | undefined {
  const inds = M.byCat[cat] ?? [];
  return (S.indicator ? inds.find((i) => i.dataset.id === S.indicator) : undefined) ?? (inds.length ? defaultIndicator(inds) : undefined);
}

function scoreMetric(label: string, get: (k: string) => number | null, formula: string): Metric {
  return { kind: 'score', label, unit: 'score', get, color: (v) => scoreColor(v), domain: [0, 100],
    ticks: [0, 25, 50, 75, 100].map((v) => ({ v, label: String(v) })), formula };
}

function categoryFormula(cat: string): string {
  const inds = (M.byCat[cat] ?? []).filter((i) => i.dataset.scoring.include);
  return `${catLabel(cat)} score = weighted mean of its scored indicators: ` +
    inds.map((i) => `${i.dataset.indicator.name} → ${describeScoring(i.dataset.scoring, i.dataset.indicator.unit)}`).join('; ');
}

function currentMetric(): Metric | null {
  if (S.cat === 'composite') {
    return scoreMetric('Composite dependence (0 = self-sufficient, 100 = most dependent)', (k) => compositeFor(M, k, S.weights).dependence, COMPOSITE_FORMULA);
  }
  const inds = M.byCat[S.cat] ?? [];
  if (!inds.length) return null;
  const chosen = S.indicator ? inds.find((i) => i.dataset.id === S.indicator) : undefined;
  if (!chosen && M.status[S.cat] === 'scored') {
    return scoreMetric(`${catLabel(S.cat)} dependence score (0–100)`, (k) => M.catScores.get(k)?.[S.cat] ?? null, categoryFormula(S.cat));
  }
  return rawMetric(chosen ?? shownIndicator(S.cat)!);
}

function visibleEntities(): Entity[] {
  return M.entities.filter((e) => e.type === 'country' || e.type === 'territory' || e.type === 'subnational' || hasAnyRow(M, e.key));
}

// ---------- shell ----------
let mapHost: HTMLElement | null = null;
let mapView: MapView | null = null;

function header(): HTMLElement {
  const link = (view: State['view'], label: string) =>
    el('a', { href: toHash({ ...S, view, selected: view === 'atlas' ? S.selected : undefined }), class: 'nav-link', 'aria-current': S.view === view ? 'page' : undefined }, label);
  return el('header', { class: 'site-header' },
    el('div', { class: 'brand' },
      el('span', { class: 'logo', 'aria-hidden': 'true' }, '◍'),
      el('div', {}, el('h1', {}, 'Globalism Calc'), el('p', { class: 'tagline' }, 'How dependent is each place on others to survive?')),
    ),
    el('nav', { 'aria-label': 'Main' }, link('atlas', 'Atlas'), link('compare', 'Compare'), link('method', 'Method & data')),
  );
}

function tabs(): HTMLElement {
  const ids = ['composite', ...M.categories.map((c) => c.id)];
  const list = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Category' });
  ids.forEach((id) => {
    const st = id === 'composite' ? 'scored' : M.status[id];
    const b = el('button', {
      role: 'tab', type: 'button', class: `tab status-${st}`, id: `tab-${id}`,
      'aria-selected': String(S.cat === id), tabindex: S.cat === id ? 0 : -1, 'aria-controls': 'main',
      onclick: () => navigate({ cat: id, indicator: undefined, view: S.view === 'method' ? 'atlas' : S.view }),
      onkeydown: (ev: Event) => {
        const k = (ev as KeyboardEvent).key;
        const i = ids.indexOf(S.cat);
        const next = k === 'ArrowRight' ? ids[(i + 1) % ids.length] : k === 'ArrowLeft' ? ids[(i - 1 + ids.length) % ids.length] : null;
        if (next) { ev.preventDefault(); navigate({ cat: next, indicator: undefined }); document.getElementById(`tab-${next}`)?.focus(); }
      },
    }, catLabel(id), id !== 'composite' && st !== 'scored' ? el('span', { class: 'badge' }, statusText[st]) : null);
    list.append(b);
  });
  return list;
}

function render() {
  const focusedId = (document.activeElement as HTMLElement | null)?.id;
  const main = el('main', { id: 'main', tabindex: -1 });
  root.replaceChildren(header(), tabs(), main);
  if (S.view === 'compare') renderCompare(main);
  else if (S.view === 'method') renderMethod(main);
  else renderAtlas(main);
  root.append(el('footer', { class: 'site-footer' },
    'Scores are relative and only as good as the data behind them. Missing data is shown as missing, never estimated. ',
    el('a', { href: toHash({ ...S, view: 'method' }) }, 'Method & sources'), ' · Map: Natural Earth via world-atlas (public domain).'));
  if (focusedId) document.getElementById(focusedId)?.focus();
}

// ---------- atlas ----------
function renderAtlas(main: HTMLElement) {
  const metric = currentMetric();
  const cat = M.categories.find((c) => c.id === S.cat);
  const inds = cat ? M.byCat[cat.id] ?? [] : [];

  const mapCard = el('section', { class: 'card map-card', 'aria-labelledby': 'map-title' });
  const head = el('div', { class: 'map-head' }, el('h2', { id: 'map-title' }, S.cat === 'composite' ? 'Composite dependence index' : cat!.label));
  if (cat) head.append(el('p', { class: 'muted' }, cat.description));
  const viewMode = inds.length > 0 && hasViews(inds) && !(M.status[cat!.id] === 'scored' && !S.indicator);
  const shown = cat ? shownIndicator(cat.id) : undefined;
  if (viewMode && shown?.dataset.view) {
    head.append(picker(inds, shown, (id) => navigate({ indicator: id })));
  } else if (inds.length) {
    const sel = el('select', { id: 'indicator-select', onchange: (ev: Event) => navigate({ indicator: (ev.target as HTMLSelectElement).value || undefined }) });
    if (M.status[cat!.id] === 'scored') sel.append(el('option', { value: '' }, 'Category score (0–100)'));
    for (const i of inds) sel.append(el('option', { value: i.dataset.id, selected: S.indicator === i.dataset.id }, `${i.dataset.indicator.name} (${i.dataset.year}, raw)`));
    head.append(el('label', { class: 'inline-field', for: 'indicator-select' }, 'Show: '), sel);
  }
  mapCard.append(head);

  if (cat && M.status[cat.id] === 'needed') mapCard.append(dataNeededBanner(cat.id));
  if (cat && M.status[cat.id] === 'context') {
    mapCard.append(el('div', { class: 'banner warn', role: 'note' },
      el('strong', {}, 'Context only. '), 'No dataset in this category is used in the dependence score yet, so there is no category score. The map shows raw values. ',
      ...(shown?.dataset.caveats?.slice(0, 1) ?? []), ' ', el('a', { href: '#need-' + cat.id, onclick: (ev: Event) => { ev.preventDefault(); document.getElementById('need-' + cat.id)?.scrollIntoView({ behavior: 'smooth' }); } }, 'Data needed ↓')));
  }
  if (S.cat === 'composite') {
    const used = M.categories.filter((c) => M.status[c.id] === 'scored' && (S.weights[c.id] ?? 0) > 0).map((c) => c.label);
    mapCard.append(el('div', { class: 'banner', role: 'note' },
      el('strong', {}, `Based on ${used.length} of ${M.categories.length} categories`), used.length ? ` (${used.join(', ')}). ` : '. ',
      'Other categories need data before they can count. Adjust weights below.'));
  }

  mapHost ??= el('div', { class: 'map' });
  mapCard.append(mapHost);
  mapView ??= createMap(mapHost, M.geo, M.entities, (k) => navigate({ selected: k }));
  mapView.update(metric, S.selected, (key, name) => {
    if (!key) return `${name}: not a dataset entity`;
    const v = metric?.get(key);
    return `${entityName(key)}: ${v == null ? 'no data' : metric!.kind === 'score' ? fmtScore(v) + ' / 100' : fmtValue(v, metric!.unit)}`;
  });
  mapCard.append(legend(metric));
  if (metric) mapCard.append(el('p', { class: 'formula' }, el('span', { class: 'formula-label' }, 'Formula: '), metric.formula));

  const detail = el('aside', { class: 'card detail', 'aria-label': 'Entity details', 'aria-live': 'polite' });
  renderDetail(detail);

  const weights = weightsCard();
  const grid = el('div', { class: 'atlas-grid' }, mapCard, detail, weights);
  main.append(grid);
  if (cat && shown && hasViews(inds) && metric?.kind === 'raw') main.append(trendCard(inds, shown, S.selected, entityName));
  main.append(rankingCard(metric));
  if (cat && hasViews(inds)) main.append(sourcesCard(inds));
  if (cat && M.status[cat.id] !== 'scored') main.append(wantedCard(cat.id));
}

function dataNeededBanner(catId: string): HTMLElement {
  const c = M.categories.find((x) => x.id === catId)!;
  return el('div', { class: 'banner need', role: 'note' },
    el('strong', {}, 'Data needed. '), `There is no ${c.label.toLowerCase()} dataset in the repo yet, so every entity is shown as missing. `,
    c.wanted?.[0] ? `Best next source: ${c.wanted[0].name} (${c.wanted[0].source}).` : '');
}

function wantedCard(catId: string): HTMLElement {
  const c = M.categories.find((x) => x.id === catId)!;
  return el('section', { class: 'card', id: 'need-' + catId, 'aria-labelledby': 'need-title-' + catId },
    el('h2', { id: 'need-title-' + catId }, `Data needed: ${c.label}`),
    el('ul', { class: 'wanted' }, ...(c.wanted ?? []).map((w) => el('li', {},
      el('strong', {}, w.name), ' · ', w.url ? el('a', { href: w.url, target: '_blank', rel: 'noopener' }, w.source) : w.source,
      w.why ? el('div', { class: 'muted' }, w.why) : null))),
    el('p', { class: 'muted' }, 'Paste a CSV/JSON export into data/raw/, add a source spec, and run npm run data:import. See the README.'));
}

function weightsCard(): HTMLElement {
  const card = el('details', { class: 'card weights', open: S.cat === 'composite' ? true : undefined });
  card.append(el('summary', {}, el('h2', {}, 'Composite weights')));
  const body = el('div', { class: 'weights-body' });
  for (const c of M.categories) {
    const st = M.status[c.id];
    const id = `w-${c.id}`;
    const out = el('output', { for: id }, String(S.weights[c.id] ?? 0));
    const input = el('input', {
      type: 'range', id, min: 0, max: 3, step: 0.25, value: S.weights[c.id] ?? 0, disabled: st !== 'scored',
      'aria-describedby': st !== 'scored' ? id + '-hint' : undefined,
      oninput: (ev: Event) => { const v = Number((ev.target as HTMLInputElement).value); S.weights = { ...S.weights, [c.id]: v }; out.textContent = String(v); saveWeights(S.weights); },
      onchange: () => render(),
    });
    body.append(el('div', { class: `weight-row status-${st}` },
      el('label', { for: id }, c.label), input, out,
      st !== 'scored' ? el('span', { class: 'badge', id: id + '-hint' }, statusText[st]) : null));
  }
  body.append(el('button', { type: 'button', class: 'btn-secondary', onclick: () => { S.weights = { ...defaultWeights }; saveWeights(S.weights); render(); } }, 'Reset weights'));
  card.append(body);
  return card;
}

function renderDetail(box: HTMLElement) {
  if (!S.selected) {
    box.append(el('h2', {}, 'Details'), el('p', { class: 'muted' }, 'Select a country or territory on the map or in the ranking to see its per-category breakdown and sources.'));
    return;
  }
  const e = M.byKey.get(S.selected)!;
  const comp = compositeFor(M, e.key, S.weights);
  box.append(
    el('div', { class: 'detail-head' },
      el('h2', {}, e.name),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close details', onclick: () => navigate({ selected: undefined }) }, '×')),
    el('p', { class: 'muted' }, `${typeLabel[e.type]}${e.parent ? ' of ' + entityName(e.parent) : ''} · ${e.key}`),
    ...(e.note ? [el('p', { class: 'muted small' }, e.note)] : []),
  );
  box.append(el('div', { class: 'big-scores' },
    el('div', {}, el('div', { class: 'big' }, fmtScore(comp.dependence)), el('div', { class: 'small muted' }, 'Composite dependence')),
    el('div', {}, el('div', { class: 'big alt' }, fmtScore(comp.selfSufficiency)), el('div', { class: 'small muted' }, 'Self-sufficiency')),
  ));
  box.append(el('p', { class: 'small muted' },
    comp.used.length ? `Uses: ${comp.used.map(catLabel).join(', ')}.` : 'No weighted category has data for this entity.',
    comp.missing.length ? ` Missing: ${comp.missing.map(catLabel).join(', ')}.` : ''));
  if (comp.used.length > 0 && comp.used.length < 3) {
    box.append(el('p', { class: 'small caveat', role: 'note' }, `Low coverage: this composite rests on ${comp.used.length} categor${comp.used.length === 1 ? 'y' : 'ies'} only, so it is not yet a measure of overall self-sufficiency.`));
  }

  for (const c of M.categories) {
    const st = M.status[c.id];
    const s = M.catScores.get(e.key)?.[c.id] ?? null;
    const row = el('div', { class: `cat-row status-${st}` });
    row.append(el('div', { class: 'cat-row-head' },
      el('span', { class: 'cat-name' }, c.label),
      st === 'scored' ? scoreBar(s) : el('span', { class: 'badge' }, statusText[st])));
    const cinds = M.byCat[c.id] ?? [];
    if (hasViews(cinds)) {
      row.append(balanceTable(cinds, e.key));
      const src = cinds[0].dataset.source;
      row.append(el('div', { class: 'small muted' }, el('a', { href: src.url, target: '_blank', rel: 'noopener' }, src.name), ` · ${src.license}`));
      for (const ind of cinds.filter((i) => !i.dataset.view)) row.append(indicatorBlock(ind, e.key));
    } else {
      for (const ind of cinds) row.append(indicatorBlock(ind, e.key));
    }
    box.append(row);
  }
  box.append(el('div', { class: 'detail-actions' },
    el('button', { type: 'button', class: 'btn', onclick: () => navigate({ view: 'compare', compare: [...new Set([...S.compare, e.key])].slice(-4) }) }, 'Add to compare')));
}

function scoreBar(s: number | null): HTMLElement {
  if (s == null) return el('span', { class: 'badge missing' }, 'no data');
  return el('span', { class: 'scorebar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(s), 'aria-label': 'score' },
    el('span', { class: 'scorebar-fill', style: `width:${s}%;background:${scoreColor(s)}` }),
    el('span', { class: 'scorebar-label', style: s > 55 ? 'color:#fff' : undefined }, fmtScore(s)));
}

function indicatorBlock(ind: IndicatorScores, key: string): HTMLElement {
  const d = ind.dataset;
  const has = ind.raw.has(key);
  const sc = ind.score.get(key) ?? null;
  return el('div', { class: 'indicator' },
    el('div', { class: 'ind-name' }, d.indicator.name, d.scoring.include ? null : el('span', { class: 'badge' }, 'context only')),
    el('div', { class: 'ind-value' }, has ? valueText(ind, key) : 'not in dataset', ' · ', String(ind.years.get(key) ?? d.year),
      d.scoring.include ? ` · score ${fmtScore(sc)}` : ''),
    el('div', { class: 'small muted' }, el('a', { href: d.source.url, target: '_blank', rel: 'noopener' }, d.source.name), ` · ${d.source.license}`),
    d.caveats?.length ? el('div', { class: 'small caveat' }, d.caveats[0]) : null,
  );
}

function rankingCard(metric: Metric | null): HTMLElement {
  const card = el('section', { class: 'card ranking', 'aria-labelledby': 'rank-title' });
  const tableWrap = el('div', { class: 'table-wrap' });
  const search = el('input', { type: 'search', id: 'search', placeholder: 'Search countries & territories…', value: S.search, autocomplete: 'off',
    oninput: (ev: Event) => { S.search = (ev.target as HTMLInputElement).value; fill(); } });
  const typeSel = el('select', { id: 'type-filter', onchange: (ev: Event) => { S.typeFilter = (ev.target as HTMLSelectElement).value as State['typeFilter']; fill(); } },
    el('option', { value: 'all', selected: S.typeFilter === 'all' }, 'All'),
    el('option', { value: 'country', selected: S.typeFilter === 'country' }, 'Countries'),
    el('option', { value: 'territory', selected: S.typeFilter === 'territory' }, 'Territories'));
  const count = el('span', { class: 'muted small', 'aria-live': 'polite' });
  card.append(
    el('div', { class: 'ranking-head' },
      el('h2', { id: 'rank-title' }, 'Ranking'),
      el('label', { class: 'sr-only', for: 'search' }, 'Search'), search,
      el('label', { class: 'sr-only', for: 'type-filter' }, 'Entity type'), typeSel, count),
    tableWrap);

  const scoredCats = M.categories.filter((c) => M.status[c.id] === 'scored');
  type Col = { id: string; label: string; get: (e: Entity) => number | string | null; fmt: (v: number | string | null) => string; num: boolean };
  const cols: Col[] = [
    { id: 'name', label: 'Entity', get: (e) => e.name, fmt: (v) => String(v), num: false },
    { id: 'type', label: 'Type', get: (e) => typeLabel[e.type], fmt: (v) => String(v), num: false },
  ];
  if (metric) cols.push({ id: 'metric', label: metric.kind === 'score' ? (S.cat === 'composite' ? 'Composite' : catLabel(S.cat) + ' score') : `Raw (${metric.unit})`,
    get: (e) => metric.get(e.key), num: true,
    fmt: (v) => (metric.kind === 'score' ? fmtScore(v as number | null) : fmtValue(v as number | null, metric.unit)) });
  const yearSet = metric?.yearOf ? new Set(visibleEntities().filter((e) => metric.get(e.key) != null).map((e) => metric.yearOf!(e.key))) : new Set();
  if (metric?.yearOf && yearSet.size > 1) cols.push({ id: 'year', label: 'Year', get: (e) => (metric.get(e.key) != null ? metric.yearOf!(e.key) ?? null : null), fmt: (v) => (v == null ? '—' : String(v)), num: true });
  if (S.cat !== 'composite') cols.push({ id: 'composite', label: 'Composite', get: (e) => compositeFor(M, e.key, S.weights).dependence, fmt: (v) => fmtScore(v as number | null), num: true });
  for (const c of scoredCats) if (c.id !== S.cat || metric?.kind === 'raw') cols.push({ id: 'cat:' + c.id, label: c.label, get: (e) => M.catScores.get(e.key)?.[c.id] ?? null, fmt: (v) => fmtScore(v as number | null), num: true });

  if (!cols.some((c) => c.id === S.sort.col)) S.sort = { col: metric ? 'metric' : 'name', dir: metric ? -1 : 1 };

  function fill() {
    const q = S.search.trim().toLowerCase();
    let rows = visibleEntities().filter((e) => S.typeFilter === 'all' || e.type === S.typeFilter);
    if (q) rows = rows.filter((e) => e.name.toLowerCase().includes(q) || e.key.toLowerCase() === q || e.aliases?.some((a) => a.toLowerCase().includes(q)));
    const col = cols.find((c) => c.id === S.sort.col)!;
    rows.sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      if (va == null && vb == null) return a.name.localeCompare(b.name);
      if (va == null) return 1; // missing always last
      if (vb == null) return -1;
      const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return r * S.sort.dir || a.name.localeCompare(b.name);
    });
    const thead = el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '#'), ...cols.map((c) => {
      const active = S.sort.col === c.id;
      return el('th', { scope: 'col', class: c.num ? 'num' : '', 'aria-sort': active ? (S.sort.dir === 1 ? 'ascending' : 'descending') : 'none' },
        el('button', { type: 'button', class: 'th-btn', onclick: () => { S.sort = { col: c.id, dir: active ? (S.sort.dir === 1 ? -1 : 1) : c.num ? -1 : 1 }; fill(); } },
          c.label, active ? (S.sort.dir === 1 ? ' ▲' : ' ▼') : ''));
    })));
    const tbody = el('tbody');
    rows.forEach((e, i) => {
      const tr = el('tr', { class: e.key === S.selected ? 'selected' : '' });
      tr.append(el('td', { class: 'num muted' }, col.num && col.get(e) != null ? String(i + 1) : ''));
      for (const c of cols) {
        const v = c.get(e);
        if (c.id === 'name') tr.append(el('td', {}, el('button', { type: 'button', class: 'link-btn', onclick: () => navigate({ selected: e.key }) }, e.name)));
        else {
          const flag = c.id === 'metric' && v != null ? metric?.flagOf?.(e.key) : undefined;
          tr.append(el('td', { class: (c.num ? 'num' : '') + (v == null ? ' missing' : '') },
            c.num && metric?.kind === 'score' && typeof v === 'number' && c.id !== 'type' ? el('span', { class: 'dot', style: `background:${scoreColor(v)}`, 'aria-hidden': 'true' }) : null, c.fmt(v),
            flag ? el('abbr', { class: 'flag', title: FLAG_TITLE[flag] ?? `Source flag "${flag}"` }, flag) : null));
        }
      }
      tbody.append(tr);
    });
    tableWrap.replaceChildren(el('table', { class: 'rank-table' }, el('caption', { class: 'sr-only' }, 'Entities ranked by the selected measure'), thead, tbody));
    count.textContent = `${rows.length} entities`;
  }
  fill();
  return card;
}

// ---------- compare ----------
function renderCompare(main: HTMLElement) {
  const card = el('section', { class: 'card', 'aria-labelledby': 'cmp-title' }, el('h2', { id: 'cmp-title' }, 'Compare (up to 4)'));
  const list = el('datalist', { id: 'entity-list' }, ...visibleEntities().map((e) => el('option', { value: e.name })));
  const input = el('input', { type: 'text', list: 'entity-list', id: 'cmp-input', placeholder: 'Type a country or territory…', autocomplete: 'off' });
  const add = () => {
    const v = input.value.trim().toLowerCase();
    const e = M.entities.find((x) => x.name.toLowerCase() === v || x.key.toLowerCase() === v);
    if (e) navigate({ compare: [...new Set([...S.compare, e.key])].slice(-4) });
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') add(); });
  card.append(el('div', { class: 'cmp-picker' }, el('label', { for: 'cmp-input' }, 'Add: '), input, list, el('button', { type: 'button', class: 'btn', onclick: add }, 'Add')));
  card.append(el('div', { class: 'chips' }, ...S.compare.map((k) => el('span', { class: 'chip' }, entityName(k),
    el('button', { type: 'button', 'aria-label': `Remove ${entityName(k)}`, onclick: () => navigate({ compare: S.compare.filter((x) => x !== k) }) }, '×')))));
  if (!S.compare.length) {
    card.append(el('p', { class: 'muted' }, 'Pick entities above, or use “Add to compare” in an entity’s detail panel.'));
    main.append(card);
    return;
  }
  const ks = S.compare;
  const tbody = el('tbody');
  const comp = ks.map((k) => compositeFor(M, k, S.weights));
  tbody.append(el('tr', { class: 'strong' }, el('th', { scope: 'row' }, 'Composite dependence'), ...comp.map((c) => el('td', {}, scoreBar(c.dependence)))));
  for (const c of M.categories) {
    const st = M.status[c.id];
    tbody.append(el('tr', { class: 'group' }, el('th', { scope: 'row' }, c.label, st !== 'scored' ? el('span', { class: 'badge' }, statusText[st]) : null),
      ...ks.map((k) => el('td', {}, st === 'scored' ? scoreBar(M.catScores.get(k)?.[c.id] ?? null) : ''))));
    for (const ind of M.byCat[c.id] ?? []) {
      tbody.append(el('tr', {}, el('th', { scope: 'row', class: 'sub' }, `${ind.dataset.indicator.name} (${ind.dataset.year})`),
        ...ks.map((k) => {
          const y = ind.years.get(k);
          const other = ind.raw.get(k) != null && y !== undefined && y !== ind.dataset.year;
          return el('td', { class: ind.raw.get(k) == null ? 'missing' : '' }, valueText(ind, k), other ? el('span', { class: 'yr' }, String(y)) : null);
        })));
    }
  }
  card.append(el('div', { class: 'table-wrap' }, el('table', { class: 'cmp-table' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, ''), ...ks.map((k) => el('th', { scope: 'col' },
      el('a', { href: toHash({ ...S, view: 'atlas', selected: k }) }, entityName(k)))))), tbody)));
  main.append(card);
}

// ---------- method ----------
function renderMethod(main: HTMLElement) {
  main.append(el('section', { class: 'card prose' },
    el('h2', {}, 'How the scores work'),
    el('p', {}, 'Every number comes from a dataset in the repository (data/datasets). Nothing is estimated or imputed: if a source has no value for an entity, it is shown as missing and left out of averages.'),
    el('ol', {},
      el('li', {}, el('strong', {}, 'Indicator score (0–100). '), 'Each dataset declares how its raw values map to 0–100 (100 = most dependent): fixed range, min–max, log min–max, or percentile rank. The formula is shown next to every map and in the list below.'),
      el('li', {}, el('strong', {}, 'Category score. '), 'Weighted mean of the scored indicators in the category that have a value for the entity.'),
      el('li', {}, el('strong', {}, 'Composite. '), COMPOSITE_FORMULA),
    ),
    el('p', {}, 'Relative methods (min–max, percentile) compare entities with each other, so a score of 80 means "more dependent than most", not "80% imported". Datasets that measure import share of consumption directly (e.g. FAO cereal import dependency, energy net imports % of use, AQUASTAT water dependency) can use a fixed 0–100 range and read literally.'),
    el('h3', {}, 'Entity keys'),
    el('p', {}, 'Countries and territories use ISO 3166-1 alpha-3 (USA, PRI, GRL). Kosovo uses XKX (World Bank) and the Channel Islands use CHI (World Bank group). States and provinces use PARENT-SUB, the parent ISO3 plus the ISO 3166-2 suffix (e.g. ISO 3166-2 US-CA → USA-CA).'),
  ));
  const cats = el('section', { class: 'card' }, el('h2', {}, 'Categories'));
  const ul = el('ul', { class: 'cat-list' });
  for (const c of M.categories) {
    const st = M.status[c.id];
    ul.append(el('li', {}, el('strong', {}, c.label), ' ', el('span', { class: `badge status-${st}` }, statusText[st]), ` · default weight ${c.defaultWeight}`,
      el('div', { class: 'muted small' }, c.description),
      st !== 'scored' && c.wanted?.length ? el('div', { class: 'small' }, 'Wanted: ', c.wanted.map((w) => `${w.name} (${w.source})`).join('; ')) : null));
  }
  cats.append(ul);
  main.append(cats);

  const ds = el('section', { class: 'card' }, el('h2', {}, `Datasets (${M.indicators.length})`));
  for (const { dataset: d, raw } of M.indicators) {
    const withVal = [...raw.values()].filter((v) => v != null).length;
    ds.append(el('article', { class: 'dataset' },
      el('h3', {}, d.title),
      el('dl', { class: 'meta' },
        ...meta('Category', catLabel(d.category)),
        ...meta('Indicator', `${d.indicator.name}${d.indicator.code ? ' [' + d.indicator.code + ']' : ''}`),
        ...meta('Unit', unitText(d)), ...meta('Year', d.series ? `${d.year} (latest; series from ${d.series.start})` : String(d.year)),
        ...meta('Source', el('a', { href: d.source.url, target: '_blank', rel: 'noopener' }, d.source.name)),
        ...(d.source.citation ? meta('Citation', d.source.citation) : []),
        ...meta('License', d.source.license),
        ...meta('Coverage', `${withVal} entities with values, ${raw.size - withVal} listed without a value`),
        ...meta('Scoring', d.scoring.include ? describeScoring(d.scoring, d.indicator.unit) : 'Not scored (context only)'),
        ...(d.scoring.rationale ? meta('Why', d.scoring.rationale) : []),
      ),
      d.indicator.description ? el('p', { class: 'small' }, d.indicator.description) : null,
      ...(d.caveats ?? []).map((c) => el('p', { class: 'small caveat' }, '⚠ ', c)),
      ...(d.notes ?? []).map((n) => el('p', { class: 'small muted' }, n)),
      el('details', {}, el('summary', {}, `Import report: ${d.import.skipped.length} source labels skipped`),
        el('p', { class: 'small muted' }, `From ${d.import.from} via ${d.import.spec}; ${d.import.rowsRead} rows read, ${d.import.matched} matched.`,
          d.import.markers && Object.keys(d.import.markers).length ? ` Non-numeric markers kept as missing: ${Object.entries(d.import.markers).map(([k, n]) => `"${k}" ×${n}`).join(', ')}.` : ''),
        el('ul', { class: 'small' }, ...d.import.skipped.map((s) => el('li', {}, `${s.name}: ${s.reason}`)))),
    ));
  }
  main.append(ds);
}

function meta(k: string, v: string | Node): HTMLElement[] {
  return [el('dt', {}, k), el('dd', {}, v)];
}

// ---------- boot ----------
async function boot() {
  try {
    M = await loadModel();
  } catch (err) {
    root.replaceChildren(el('p', { class: 'error', role: 'alert' }, `Could not load data: ${(err as Error).message}`));
    return;
  }
  defaultWeights = Object.fromEntries(M.categories.map((c) => [c.id, c.defaultWeight]));
  S = { view: 'atlas', cat: 'composite', compare: [], weights: loadWeights(defaultWeights), search: '', typeFilter: 'all', sort: { col: 'metric', dir: -1 } };
  fromHash();
  window.addEventListener('hashchange', () => { fromHash(); render(); });
  render();
}
boot();
