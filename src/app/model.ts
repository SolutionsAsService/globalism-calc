import type { CategoryDef, Dataset, Entity, Manifest } from '../lib/types';
import { byCategory, categoryScore, categoryStatus, composite, scoreDataset, type IndicatorScores, type Score } from '../lib/scoring';

export interface Model {
  entities: Entity[];
  byKey: Map<string, Entity>;
  categories: CategoryDef[];
  indicators: IndicatorScores[];
  byCat: Record<string, IndicatorScores[]>;
  status: Record<string, 'scored' | 'context' | 'needed'>;
  /** Category scores per entity key (null = missing). */
  catScores: Map<string, Record<string, Score>>;
  geo: unknown;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`data/${path}`);
  if (!res.ok) throw new Error(`Failed to load data/${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadModel(): Promise<Model> {
  const manifest = await getJson<Manifest>('manifest.json');
  const [entities, categories, geo, ...datasets] = await Promise.all([
    getJson<Entity[]>(manifest.entities),
    getJson<CategoryDef[]>(manifest.categories),
    getJson<unknown>(manifest.geo),
    ...manifest.datasets.map((d) => getJson<Dataset>(d.file)),
  ]);
  return buildModel(entities, categories, datasets as Dataset[], geo);
}

export function buildModel(entities: Entity[], categories: CategoryDef[], datasets: Dataset[], geo: unknown = null): Model {
  const indicators = datasets.map(scoreDataset);
  const byCat = byCategory(categories, indicators);
  const status: Model['status'] = {};
  for (const c of categories) status[c.id] = categoryStatus(byCat[c.id]);
  const catScores = new Map<string, Record<string, Score>>();
  for (const e of entities) {
    const rec: Record<string, Score> = {};
    for (const c of categories) rec[c.id] = categoryScore(e.key, byCat[c.id] ?? []);
    catScores.set(e.key, rec);
  }
  return { entities, byKey: new Map(entities.map((e) => [e.key, e])), categories, indicators, byCat, status, catScores, geo };
}

export function compositeFor(m: Model, key: string, weights: Record<string, number>) {
  return composite(m.catScores.get(key) ?? {}, weights);
}

/** Does this entity appear in any dataset at all (with or without a value)? */
export function hasAnyRow(m: Model, key: string): boolean {
  return m.indicators.some((i) => i.raw.has(key));
}
