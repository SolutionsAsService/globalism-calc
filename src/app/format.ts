const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

export function fmtScore(s: number | null | undefined): string {
  return s == null ? '—' : plain.format(Math.round(s * 10) / 10);
}

export function fmtValue(v: number | null | undefined, unit: string): string {
  if (v == null) return 'missing';
  if (/usd/i.test(unit)) return '$' + compact.format(v);
  if (unit.startsWith('%')) return plain.format(v) + unit.replace(/^%/, '%');
  return Math.abs(v) >= 1e5 ? compact.format(v) + ' ' + unit : plain.format(v) + ' ' + unit;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined | null | EventListener> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') node.className = String(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

export const typeLabel: Record<string, string> = { country: 'Country', territory: 'Territory', subnational: 'State / province', other: 'Other area' };
