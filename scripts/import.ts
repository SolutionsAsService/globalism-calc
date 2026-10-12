/**
 * Imports every data/sources/*.source.json (or the ones passed as args) into data/datasets/<id>.json,
 * then computes every data/sources/*.derived.json from the normalized datasets (see src/lib/derive.ts).
 * Run: npm run data:import [-- data/sources/foo.source.json]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalize, readRowsCached, type SourceSpec } from '../src/lib/importer';
import { deriveDataset, deriveInputs, type DerivedSpec } from '../src/lib/derive';
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
    if (spec.dataset.source.sha256) {
      const sha = createHash('sha256').update(readFileSync(spec.input)).digest('hex');
      if (sha !== spec.dataset.source.sha256) throw new Error(`${spec.input} has SHA-256 ${sha}, but the spec records ${spec.dataset.source.sha256} (raw files must not change; re-download into a new file and update the spec)`);
    }
    const rows = readRowsCached(spec, (p) => readFileSync(p, 'utf8'));
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
// Derived specs can use other derived datasets (e.g. electricity exposure uses fuel dependence): run them in dependency order.
const pending = derivedSpecs.map((specPath) => ({ specPath, spec: JSON.parse(readFileSync(specPath, 'utf8')) as DerivedSpec }));
const derivedIds = new Set(pending.map((p) => p.spec.dataset.id));
const ordered: typeof pending = [];
while (pending.length) {
  const i = pending.findIndex((p) => deriveInputs(p.spec.derive).every((id) => !derivedIds.has(id) || ordered.some((o) => o.spec.dataset.id === id)));
  if (i < 0) { console.error(`✘ circular derived specs: ${pending.map((p) => p.specPath).join(', ')}`); process.exit(1); }
  ordered.push(...pending.splice(i, 1));
}
for (const { specPath, spec } of ordered) {
  try {
    const ids = deriveInputs(spec.derive);
    const inputs = new Map<string, Dataset>();
    for (const id of ids) { const x = input(id); if (x) inputs.set(id, x); }
    const ds = deriveDataset(spec, inputs, specPath);
    fresh.set(ds.id, ds);
    const out = write(ds);
    console.log(`✔ ${specPath} -> ${out}: ${ds.rows.length - ds.import.missingValues} entities with values, ${ds.import.missingValues} without a common year`);
  } catch (e) {
    failed = true;
    console.error(`✘ ${specPath}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
