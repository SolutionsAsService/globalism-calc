import { el } from './format';
import { compositeFor, type DatasetOverrides, type Model } from './model';
import { toHash, type State } from './state';
import { describeScoring, type IndicatorScores } from '../lib/scoring';

export interface DataViewCtx {
  M: Model;
  S: State;
  defaultWeights: Record<string, number>;
  catLabel: (id: string) => string;
  setOverrides: (o: DatasetOverrides) => void;
  setWeights: (w: Record<string, number>) => void;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag: string, attrs: Record<string, string | number | undefined>, ...kids: (Node | string)[]): SVGElement {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) n.setAttribute(k, String(v));
  for (const c of kids) n.append(c);
  return n;
}

const values = (i: IndicatorScores) => [...i.raw.values()].filter((v) => v != null).length;
const yearsText = (i: IndicatorScores) => {
  const ys = [...i.raw].filter(([, v]) => v != null).map(([k]) => i.years.get(k)!).filter(Number.isFinite);
  if (!ys.length) return String(i.dataset.year);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return lo === hi ? String(hi) : `${lo}–${hi}`;
};
const origin = (i: IndicatorScores) =>
  i.dataset.import.from.includes('raw/uploads') ? 'uploaded' : i.dataset.import.from.startsWith('derived:') ? 'derived' : null;
const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Datasets → categories → composite, edge width = weight, dashed = context only (not scored). */
function dependencyMap(ctx: DataViewCtx): SVGElement {
  const { M, S } = ctx;
  const cats = M.categories;
  const inds = cats.flatMap((c) => M.byCat[c.id] ?? []);
  const rowH = 26, top = 30, W = 1000;
  const H = Math.max(top + inds.length * rowH + 10, top + cats.length * 70);
  const xD = 10, wD = 400, xC = 560, wC = 200, xT = 870, wT = 120;
  const yD = new Map(inds.map((i, n) => [i.dataset.id, top + n * rowH + rowH / 2]));
  // categories centred on their datasets (categories without data spread into the gaps at the bottom)
  const yC = new Map<string, number>();
  let free = top + inds.length * rowH;
  for (const c of cats) {
    const ys = (M.byCat[c.id] ?? []).map((i) => yD.get(i.dataset.id)!);
    yC.set(c.id, ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : (free += 34) - 17);
  }
  const yT = H / 2;
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
  const g = svg('g', {});
  const head = (x: number, t: string) => g.append(svg('text', { x, y: 16, class: 'dm-head' }, t));
  head(xD, `Datasets (${inds.length})`); head(xC, 'Categories'); head(xT, 'Composite');
  for (const i of inds) {
    const d = i.dataset, y = yD.get(d.id)!, used = d.scoring.include && (d.scoring.weight ?? 1) > 0;
    g.append(svg('path', { d: curve(xD + wD, y, xC, yC.get(d.category)!), class: used ? 'dm-edge used' : 'dm-edge context', 'stroke-width': used ? 1 + 2 * (d.scoring.weight ?? 1) : 1 }));
    const a = svg('a', { href: toHash({ ...S, view: 'atlas', cat: d.category, indicator: d.id, selected: undefined }) },
      svg('rect', { x: xD, y: y - 10, width: wD, height: 20, rx: 4, class: used ? 'dm-node used' : 'dm-node context' }),
      svg('text', { x: xD + 6, y: y + 4 }, trim(d.title, 52)),
      svg('text', { x: xD + wD - 6, y: y + 4, 'text-anchor': 'end', class: 'dm-n' }, String(values(i))),
      svg('title', {}, `${d.title}\n${used ? 'scored' : 'context only'} · ${values(i)} entities · ${yearsText(i)}${origin(i) ? ' · ' + origin(i) : ''}`));
    g.append(a);
  }
  for (const c of cats) {
    const y = yC.get(c.id)!, st = M.status[c.id], w = S.weights[c.id] ?? 0, on = st === 'scored' && w > 0;
    g.append(svg('path', { d: curve(xC + wC, y, xT, yT), class: on ? 'dm-edge used' : 'dm-edge context', 'stroke-width': on ? 1 + 2 * w : 1 }));
    g.append(svg('rect', { x: xC, y: y - 13, width: wC, height: 26, rx: 13, class: `dm-cat status-${st}` }),
      svg('text', { x: xC + 10, y: y + 4 }, c.label),
      svg('text', { x: xC + wC - 10, y: y + 4, 'text-anchor': 'end', class: 'dm-n' }, st === 'scored' ? '×' + w : st === 'context' ? 'context' : 'needed'));
  }
  const n = M.entities.filter((e) => compositeFor(M, e.key, S.weights).dependence != null).length;
  g.append(svg('rect', { x: xT, y: yT - 26, width: wT, height: 52, rx: 8, class: 'dm-total' }),
    svg('text', { x: xT + wT / 2, y: yT - 4, 'text-anchor': 'middle' }, 'Composite'),
    svg('text', { x: xT + wT / 2, y: yT + 14, 'text-anchor': 'middle', class: 'dm-n' }, `${n} scored`));
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dep-map', role: 'img', 'aria-label': 'Dependency map: datasets feed categories, categories feed the composite. Thick lines carry more weight; dashed lines are context only.' }, g);
}

export function renderData(main: HTMLElement, ctx: DataViewCtx) {
  const { M, S, catLabel } = ctx;
  const inds = M.categories.flatMap((c) => M.byCat[c.id] ?? []);
  const scored = inds.filter((i) => i.dataset.scoring.include);
  const catsScored = M.categories.filter((c) => M.status[c.id] === 'scored');
  const composite = M.entities.filter((e) => compositeFor(M, e.key, S.weights).dependence != null).length;
  const uploaded = inds.filter((i) => origin(i) === 'uploaded');

  main.append(el('section', { class: 'card' },
    el('h2', {}, 'Datasets & dependency map'),
    el('p', { class: 'muted' }, 'Every dataset in data/datasets is loaded automatically. Each one feeds a category; scored categories feed the composite. Turn datasets on or off and change weights below: the map, ranking and composite update at once. Your choices are saved in this browser only.'),
    el('div', { class: 'stats' },
      ...[[inds.length, 'datasets'], [scored.length, 'scored'], [`${catsScored.length}/${M.categories.length}`, 'categories scored'], [composite, 'places with a composite'], [uploaded.length, 'uploaded tables']]
        .map(([v, l]) => el('div', { class: 'stat' }, el('div', { class: 'big' }, String(v)), el('div', { class: 'small muted' }, String(l))))),
    el('div', { class: 'dep-wrap' }, dependencyMap(ctx)),
    el('p', { class: 'small muted' }, 'Line width = weight. Dashed = not used in the score (context). Numbers on datasets = entities with a value. Click a dataset to open it on the map.'),
  ));

  // Category weights (composite)
  const cw = el('section', { class: 'card' }, el('h2', {}, 'Composite: category weights'));
  for (const c of M.categories) {
    const st = M.status[c.id], id = 'dw-' + c.id, out = el('output', { for: id }, String(S.weights[c.id] ?? 0));
    cw.append(el('div', { class: `weight-row status-${st}` }, el('label', { for: id }, c.label),
      el('input', { type: 'range', id, min: 0, max: 3, step: 0.25, value: S.weights[c.id] ?? 0, disabled: st !== 'scored',
        oninput: (ev: Event) => { out.textContent = (ev.target as HTMLInputElement).value; },
        onchange: (ev: Event) => ctx.setWeights({ ...S.weights, [c.id]: Number((ev.target as HTMLInputElement).value) }) }),
      out, st !== 'scored' ? el('span', { class: 'badge' }, st === 'context' ? 'context only' : 'data needed') : null));
  }
  main.append(cw);

  // Datasets table with toggles
  const set = (id: string, patch: { include?: boolean; weight?: number }) => ctx.setOverrides({ ...S.ds, [id]: { ...S.ds[id], ...patch } });
  const tbody = el('tbody', {});
  for (const i of inds) {
    const d = i.dataset, base = M.datasets.find((x) => x.id === d.id)!.scoring, changed = !!S.ds[d.id];
    const w = d.scoring.weight ?? 1, wid = 'wt-' + d.id, out = el('output', { for: wid }, String(w));
    tbody.append(el('tr', { class: d.scoring.include ? '' : 'is-context' },
      el('th', { scope: 'row' },
        el('a', { href: toHash({ ...S, view: 'atlas', cat: d.category, indicator: d.id, selected: undefined }) }, d.title),
        origin(i) ? el('span', { class: 'badge' }, origin(i)!) : null, changed ? el('span', { class: 'badge changed' }, 'changed') : null,
        el('div', { class: 'small muted' }, `${d.indicator.name} · ${d.indicator.unit}`)),
      el('td', {}, catLabel(d.category)),
      el('td', { class: 'num' }, String(values(i))),
      el('td', {}, yearsText(i)),
      el('td', { class: 'small' }, d.scoring.include ? describeScoring(d.scoring, d.indicator.unit).split(';')[0] : 'context'),
      el('td', {}, el('input', { type: 'checkbox', checked: d.scoring.include ? true : undefined, 'aria-label': `Use ${d.title} in the score`,
        title: base.include ? 'Scored by default' : 'Context by default', onchange: (ev: Event) => set(d.id, { include: (ev.target as HTMLInputElement).checked }) })),
      el('td', {}, el('input', { type: 'range', id: wid, min: 0, max: 3, step: 0.25, value: w, disabled: d.scoring.include ? undefined : true, 'aria-label': `Weight of ${d.title} in ${catLabel(d.category)}`,
        oninput: (ev: Event) => { out.textContent = (ev.target as HTMLInputElement).value; },
        onchange: (ev: Event) => set(d.id, { weight: Number((ev.target as HTMLInputElement).value) }) }), out),
      el('td', { class: 'small' }, el('a', { href: d.source.url, target: '_blank', rel: 'noopener' }, trim(d.source.name, 40)))));
  }
  main.append(el('section', { class: 'card' },
    el('div', { class: 'detail-head' }, el('h2', {}, 'All datasets'),
      el('button', { type: 'button', class: 'btn-secondary', onclick: () => ctx.setOverrides({}) }, 'Reset datasets to defaults')),
    el('p', { class: 'small muted' }, 'Context datasets are off by default because they would double count or do not measure dependence (see each dataset on the Method page). You can still switch them on to explore.'),
    el('div', { class: 'table-wrap' }, el('table', { class: 'ds-table' },
      el('thead', {}, el('tr', {}, ...['Dataset', 'Category', 'Values', 'Year(s)', 'Scoring', 'Use', 'Weight', 'Source'].map((h) => el('th', { scope: 'col' }, h)))),
      tbody))));
}
