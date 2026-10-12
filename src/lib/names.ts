import type { Entity } from './types';

/** Normalize an entity label for matching: strips accents, punctuation, case and a leading "the". */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/\s+/g, ' ');
}

export interface AliasFile {
  /** Source label -> entity key. Exact (normalized) match. */
  aliases: Record<string, string>;
  /** Source labels/codes that are not entities (regional aggregates, pseudo-partners) -> reason. */
  nonEntities: Record<string, string>;
}

export interface Matcher {
  match(label: string): { key: string } | { skip: string } | null;
}

/** Build a matcher over entity names, codes and aliases. Ambiguous aliases (shared by >1 entity) are dropped. */
export function buildMatcher(entities: Entity[], aliasFile: AliasFile): Matcher {
  const byName = new Map<string, string | null>();
  const add = (label: string, key: string) => {
    const n = normalizeName(label);
    if (!n) return;
    const prev = byName.get(n);
    if (prev === undefined) byName.set(n, key);
    else if (prev !== key) byName.set(n, null); // ambiguous
  };
  for (const e of entities) {
    add(e.name, e.key);
    for (const a of e.aliases ?? []) add(a, e.key);
  }
  const codes = new Map<string, string>();
  for (const e of entities) {
    codes.set(e.key.toUpperCase(), e.key);
    if (e.iso3) codes.set(e.iso3.toUpperCase(), e.key);
    if (e.iso2) codes.set(e.iso2.toUpperCase(), e.key);
  }
  const explicit = new Map<string, string>();
  for (const [label, key] of Object.entries(aliasFile.aliases)) explicit.set(normalizeName(label), key);
  const skips = new Map<string, string>();
  for (const [label, reason] of Object.entries(aliasFile.nonEntities)) skips.set(normalizeName(label), reason);
  const keys = new Set(entities.map((e) => e.key));

  return {
    match(label: string) {
      const raw = String(label ?? '').trim();
      if (!raw) return null;
      const n = normalizeName(raw);
      // Explicit decisions win over automatic matching.
      const ex = explicit.get(n);
      if (ex) {
        if (!keys.has(ex)) throw new Error(`Alias "${raw}" points to unknown entity key "${ex}"`);
        return { key: ex };
      }
      const skip = skips.get(n);
      if (skip) return { skip };
      const code = codes.get(raw.toUpperCase());
      if (code && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,3})?$/.test(raw)) return { key: code };
      const named = byName.get(n);
      if (named) return { key: named };
      return null;
    },
  };
}
