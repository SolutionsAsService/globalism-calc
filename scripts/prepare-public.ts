/**
 * Copies normalized data into public/data so Vite serves it at /data (dev) and emits it into dist/data (build).
 * Writes public/data/manifest.json listing every dataset. Run automatically by npm run dev/build.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import type { Dataset, Manifest } from '../src/lib/types';

const out = 'public/data';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/datasets`, { recursive: true });
mkdirSync(`${out}/geo`, { recursive: true });

const datasets: Manifest['datasets'] = [];
for (const f of readdirSync('data/datasets').filter((f) => f.endsWith('.json')).sort()) {
  const ds: Dataset = JSON.parse(readFileSync(`data/datasets/${f}`, 'utf8'));
  writeFileSync(`${out}/datasets/${f}`, JSON.stringify(ds));
  datasets.push({ id: ds.id, file: `datasets/${f}`, category: ds.category, title: ds.title });
}
const entities = JSON.parse(readFileSync('data/reference/entities.json', 'utf8'));
writeFileSync(`${out}/entities.json`, JSON.stringify(entities));
copyFileSync('data/categories.json', `${out}/categories.json`);
copyFileSync('data/geo/countries-50m.json', `${out}/geo/countries-50m.json`);
const manifest: Manifest = { generatedFrom: 'data/', datasets, categories: 'categories.json', entities: 'entities.json', geo: 'geo/countries-50m.json' };
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log(`public/data ready: ${datasets.length} datasets`);
