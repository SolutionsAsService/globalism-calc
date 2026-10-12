export type View = 'atlas' | 'compare' | 'method';

export interface State {
  view: View;
  /** 'composite' or a category id. */
  cat: string;
  /** Dataset id shown on the map for a category (defaults to the first). */
  indicator?: string;
  selected?: string;
  compare: string[];
  weights: Record<string, number>;
  search: string;
  typeFilter: 'all' | 'country' | 'territory';
  sort: { col: string; dir: 1 | -1 };
}

const WEIGHTS_KEY = 'globalism-calc:weights:v1';

export function loadWeights(defaults: Record<string, number>): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(WEIGHTS_KEY) ?? '{}');
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) if (typeof saved[k] === 'number') out[k] = saved[k];
    return out;
  } catch {
    return { ...defaults };
  }
}

export function saveWeights(w: Record<string, number>) {
  try { localStorage.setItem(WEIGHTS_KEY, JSON.stringify(w)); } catch { /* private mode */ }
}

/** Hash routes: #/?cat=food&sel=USA | #/compare?keys=USA,CHN&cat=... | #/method */
export function parseHash(hash: string): Partial<State> {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const q = new URLSearchParams(query);
  const out: Partial<State> = {};
  out.view = path === '/compare' ? 'compare' : path === '/method' ? 'method' : 'atlas';
  if (q.get('cat')) out.cat = q.get('cat')!;
  if (q.get('ind')) out.indicator = q.get('ind')!;
  if (q.get('sel')) out.selected = q.get('sel')!;
  if (q.get('keys')) out.compare = q.get('keys')!.split(',').filter(Boolean).slice(0, 4);
  return out;
}

export function toHash(s: State): string {
  const q = new URLSearchParams();
  if (s.cat !== 'composite') q.set('cat', s.cat);
  if (s.indicator) q.set('ind', s.indicator);
  if (s.selected) q.set('sel', s.selected);
  if (s.view === 'compare' && s.compare.length) q.set('keys', s.compare.join(','));
  const path = s.view === 'compare' ? '/compare' : s.view === 'method' ? '/method' : '/';
  const qs = q.toString();
  return '#' + path + (qs ? '?' + qs : '');
}
