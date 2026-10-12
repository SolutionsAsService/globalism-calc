/**
 * Builds data/reference/entities.json from ISO 3166-1 (i18n-iso-countries) + data/reference/territories.json
 * + data/reference/subnational.json. Run: npm run data:entities
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import countries from 'i18n-iso-countries';
import type { Entity, EntityType } from '../src/lib/types';

const require = createRequire(import.meta.url);
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const terr = JSON.parse(readFileSync('data/reference/territories.json', 'utf8'));
const sub = JSON.parse(readFileSync('data/reference/subnational.json', 'utf8'));

const entities: Entity[] = [];
const all = countries.getNames('en', { select: 'all' }) as Record<string, string[]>;
for (const [iso2, names] of Object.entries(all)) {
  const iso3 = countries.alpha2ToAlpha3(iso2);
  if (!iso3) continue;
  if (iso2 === 'XK') continue; // Kosovo is defined in territories.json "extra" with the World Bank code XKX
  const numeric = countries.alpha3ToNumeric(iso3);
  let type: EntityType = 'country';
  let parent: string | undefined;
  if (iso3 in terr.territory) { type = 'territory'; parent = terr.territory[iso3] ?? undefined; }
  if (iso3 in terr.other) { type = 'other'; parent = terr.other[iso3] ?? undefined; }
  const name: string = terr.nameOverrides[iso3] ?? names[0];
  const aliases = [...new Set(names.filter((n) => n !== name))];
  entities.push({ key: iso3, name, type, iso3, iso2, numeric, ...(parent ? { parent } : {}), ...(aliases.length ? { aliases } : {}) });
}
for (const e of [...terr.extra, ...sub.entities] as Entity[]) {
  if (entities.some((x) => x.key === e.key)) throw new Error(`Duplicate entity key ${e.key}`);
  entities.push(e);
}
entities.sort((a, b) => a.key.localeCompare(b.key));
writeFileSync('data/reference/entities.json', JSON.stringify(entities, null, 1) + '\n');
console.log(`Wrote ${entities.length} entities (${entities.filter((e) => e.type === 'country').length} countries, ${entities.filter((e) => e.type === 'territory').length} territories, ${entities.filter((e) => e.type === 'subnational').length} subnational)`);
