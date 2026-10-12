/**
 * Imports every data/sources/*.source.json (or the ones passed as args) into data/datasets/<id>.json,
 * then computes every data/sources/*.derived.json from the normalized datasets (see src/lib/derive.ts).
 * Run: npm run data:import [-- data/sources/foo.source.json]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalize, readRows, type SourceSpec } from '../src/lib/importer';
import { deriveDataset, type DerivedSpec } from '../src/lib/derive';
import type { Dataset, Entity } from '../src/lib/types';
import type { AliasFile } from '../src/lib/names';

const entities: Entity[] = JSON.parse(readFileSync('data/reference/entities.json', 'utf8'));
const aliasFile: AliasFile = JSON.parse(readFileSync('data/reference/aliases.json', 'utf8'));

const args = process.argv.slice(2);
const specs = args.length ? args : readdirSync('data/sources').filter((f) => f.endsWith('.source.json')).sort().map((f) => join('data/sources', f));
const derivedSpecs = readdirSync('data/sources').filter((f) => f.endsWith('.derived.json')).sort().map((f) => join('data/sources', f));
mkdirSync('data/datasets', { recursive: true });

const write = (ds: Dataset) => {
  const out = join('data/datasets', `${ds.id}.json`);
  writeFileSync(out, JSON.stringify(ds, null, 1) + '\n');
  return out;
};

let failed = false;
const fresh = new Map<string, Dataset>();
for (const specPath of specs) {
  try {
    const spec: SourceSpec = JSON.parse(readFileSync(specPath, 'utf8'));
    const rows = readRows(spec, readFileSync(spec.input, 'utf8'));
    const ds = normalize(spec, rows, entities, aliasFile, specPath);
    fresh.set(ds.id, ds);
    const out = write(ds);
    const withValue = ds.rows.length - ds.import.missingValues;
    console.log(`✔ ${specPath} -> ${out}: ${withValue} entities with values, ${ds.import.missingValues} explicitly missing, ${ds.import.skipped.length} skipped (aggregates/pseudo-areas)`);
  } catch (e) {
    failed = true;
    console.error(`✘ ${specPath}: ${(e as Error).message}`);
  }
}

// Derived datasets read their inputs from this run, falling back to the committed normalized files.
const input = (id: string): Dataset | undefined => {
  if (fresh.has(id)) return fresh.get(id);
  const p = join('data/datasets', `${id}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
};
for (const specPath of derivedSpecs) {
  try {
    const spec: DerivedSpec = JSON.parse(readFileSync(specPath, 'utf8'));
    const d = spec.derive;
    const ids = d.op === 'net' ? [d.imports, d.exports] : [d.imports, d.exports, d.base];
    const inputs = new Map<string, Dataset>();
    for (const id of ids) { const x = input(id); if (x) inputs.set(id, x); }
    const ds = deriveDataset(spec, inputs, specPath);
    const out = write(ds);
    console.log(`✔ ${specPath} -> ${out}: ${ds.rows.length - ds.import.missingValues} entities with values, ${ds.import.missingValues} without a common year`);
  } catch (e) {
    failed = true;
    console.error(`✘ ${specPath}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
