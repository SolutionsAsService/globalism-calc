/**
 * Imports every data/sources/*.source.json (or the ones passed as args) into data/datasets/<id>.json.
 * Run: npm run data:import [-- data/sources/foo.source.json]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalize, readRows, type SourceSpec } from '../src/lib/importer';
import type { Entity } from '../src/lib/types';
import type { AliasFile } from '../src/lib/names';

const entities: Entity[] = JSON.parse(readFileSync('data/reference/entities.json', 'utf8'));
const aliasFile: AliasFile = JSON.parse(readFileSync('data/reference/aliases.json', 'utf8'));

const args = process.argv.slice(2);
const specs = args.length ? args : readdirSync('data/sources').filter((f) => f.endsWith('.source.json')).map((f) => join('data/sources', f));
mkdirSync('data/datasets', { recursive: true });

let failed = false;
for (const specPath of specs) {
  try {
    const spec: SourceSpec = JSON.parse(readFileSync(specPath, 'utf8'));
    const rows = readRows(spec, readFileSync(spec.input, 'utf8'));
    const ds = normalize(spec, rows, entities, aliasFile, specPath);
    const out = join('data/datasets', `${ds.id}.json`);
    writeFileSync(out, JSON.stringify(ds, null, 1) + '\n');
    const withValue = ds.rows.length - ds.import.missingValues;
    console.log(`✔ ${specPath} -> ${out}: ${withValue} entities with values, ${ds.import.missingValues} explicitly missing, ${ds.import.skipped.length} skipped (aggregates/pseudo-areas)`);
  } catch (e) {
    failed = true;
    console.error(`✘ ${specPath}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
