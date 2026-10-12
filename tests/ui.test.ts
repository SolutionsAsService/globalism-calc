// @vitest-environment jsdom
/** UI smoke test: boots the real app against public/data (prepared by `npm test`) in jsdom. */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const until = async (fn: () => boolean, ms = 20000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for UI');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const go = async (hash: string, ready: () => boolean) => {
  location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await until(ready);
};
const $ = (s: string) => document.querySelector(s);
const $$ = (s: string) => [...document.querySelectorAll(s)];

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace(/^.*?data\//, 'public/data/');
    try {
      const body = readFileSync(path, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body) } as Response;
    } catch {
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }
  });
  document.body.innerHTML = '<div id="app"></div>';
  await import('../src/main');
  await until(() => !!$('.rank-table'));
});

describe('app', () => {
  it('renders tabs, the map and the ranking on the composite view', () => {
    expect($$('[role="tab"]').length).toBe(8);
    expect($('[role="tab"][aria-selected="true"]')?.textContent).toContain('Composite');
    const paths = $$('path.country');
    expect(paths.length).toBe(241);
    expect(paths.filter((p) => p.getAttribute('fill')?.startsWith('rgb')).length).toBeGreaterThan(100);
    expect(paths.filter((p) => p.getAttribute('fill') === 'url(#hatch)').length).toBeGreaterThan(10); // missing stays missing
    expect($$('.rank-table tbody tr').length).toBeGreaterThan(200);
    expect($('.formula')?.textContent).toMatch(/Σ/);
  });

  it('food tab is context-only and the detail panel shows sources', async () => {
    await go('#/?cat=food&sel=USA', () => $('.detail h2')?.textContent === 'United States');
    expect($('.banner.warn')?.textContent).toMatch(/Context only/);
    expect($('.detail')?.textContent).toMatch(/World Bank WITS/);
    expect($('.detail')?.textContent).toMatch(/\$57\.7B/);
  });

  it('categories without data say "data needed" and paint everything as missing', async () => {
    await go('#/?cat=water', () => !!$('.banner.need'));
    expect($$('path.country').every((p) => p.getAttribute('fill') === 'url(#hatch)')).toBe(true);
    expect($('#need-water')?.textContent).toMatch(/AQUASTAT/);
  });

  it('energy tab: scored by electricity import exposure, with score button, group picker and score note', async () => {
    await go('#/?cat=energy', () => !!$('#fuel-select'));
    expect($('[role="tab"][aria-selected="true"]')?.textContent).toMatch(/Fuel & energy/);
    expect($('.banner.warn')).toBeNull(); // no longer context-only
    expect($('#score-note')?.textContent).toMatch(/Electricity import exposure \(\d+ entities with a value\)/);
    expect($('#show-score')?.getAttribute('aria-pressed')).toBe('true');
    expect(($('#fuel-select') as HTMLSelectElement).value).toBe('electricity-exposure');
    expect($$('.seg-btn[aria-pressed="true"]').map((b) => b.id)).toEqual(['show-score']);
    expect($('.legend-title')?.textContent).toMatch(/Fuel & energy dependence score/);
    expect($('.formula')?.textContent).toMatch(/Electricity import exposure → 100 × clamp/);
    expect($('#need-energy')).toBeNull();
    const opts = [...($('#fuel-select') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opts.slice(0, 4)).toEqual(['Electricity: import exposure', 'Electricity: generation by source', 'Electricity: trade (EIA)', 'Fossil fuels: import dependence (EI)']);
    expect($('#energy-sources')?.textContent).toMatch(/petrol-import-SeriesExport-10-12-2026-18-11-05\.json/);
    expect($('#energy-sources')?.textContent).toMatch(/2026-10-12 18:11:05 UTC/);
    expect($('#energy-sources')?.textContent).toMatch(/owid_energy\.csv/);
    expect($('#energy-sources')?.textContent).toMatch(/Ember – Yearly Electricity Data.*CC BY 4\.0/);
    expect($('#energy-sources')?.textContent).toMatch(/9d8efc4a9b1c/);
  });

  it('energy tab: raw series, EIA units, diverging net map, ranking columns, balance table and trend', async () => {
    await go('#/?cat=energy&ind=eia-crude-oil-net-imports', () => /TBPD/.test($('.legend-title')?.textContent ?? ''));
    expect($('.legend-title')?.textContent).toMatch(/TBPD \(thousand barrels per day\).*net importer/);
    expect($('#show-score')?.getAttribute('aria-pressed')).toBe('false');
    expect($$('path.country').filter((p) => p.getAttribute('fill')?.startsWith('rgb')).length).toBeGreaterThan(100);
    const fuel = $('#fuel-select') as HTMLSelectElement;
    fuel.value = 'natural-gas';
    fuel.dispatchEvent(new Event('change'));
    await until(() => /BCF \(billion cubic feet\)/.test($('.legend-title')?.textContent ?? ''));
    expect(location.hash).toContain('ind=eia-natural-gas-net-imports');
    ($('#flow-imports') as HTMLButtonElement).click();
    await until(() => location.hash.includes('ind=eia-natural-gas-imports'));
    const head = $('.rank-table thead')?.textContent ?? '';
    expect(head).toMatch(/Raw \(BCF\)/);
    expect(head).toMatch(/Import exposure/); // key electricity columns are sortable in the ranking
    expect(head).toMatch(/kWh per person/);

    await go('#/?cat=energy&ind=eia-natural-gas-imports&sel=DEU', () => $('.detail h2')?.textContent === 'Germany');
    const bal = $('.detail table.balance:not(.exposure-table):not(.facts-table)')?.textContent ?? '';
    expect(bal).toMatch(/Dry natural gas/);
    expect(bal).toMatch(/2,622\.4/);
    expect($('.detail')?.textContent).toMatch(/Energy Information Administration/);
    expect($('.trend h2')?.textContent).toMatch(/Germany · Dry natural gas/);
    expect($$('.trend .trend-svg path.trend-line').length).toBe(3); // imports, exports, net
    expect($('.trend-table')?.textContent).toMatch(/2024/);

    await go('#/?cat=energy&ind=eia-electricity-net-import-share&sel=LUX', () => $('.detail h2')?.textContent === 'Luxembourg');
    expect($('.legend-title')?.textContent).toMatch(/% of net consumption/);
    expect($('.formula')?.textContent).toMatch(/Not used in any score: .*double count/);
  });

  it('electricity panel: Japan exposure breakdown, generation mix bar + stacked chart, key figures; bounds when not computable', async () => {
    await go('#/?cat=energy&sel=JPN', () => $('.detail h2')?.textContent === 'Japan');
    const ex = $('#exposure-block')?.textContent ?? '';
    expect(ex).toMatch(/Electricity import exposure/);
    expect(ex).toMatch(/67\.8%/);
    expect(ex).toMatch(/Gas power/);
    expect(ex).toMatch(/not counted/); // nuclear & renewables
    expect($$('#exposure-block .stackbar-seg').length).toBe(3); // coal, gas, oil (no direct imports)
    const mix = $('#mix-block')?.textContent ?? '';
    expect(mix).toMatch(/Generation mix/);
    expect(mix).toMatch(/Gas \d/);
    expect(mix).toMatch(/Nuclear \d/);
    expect($$('#mix-block .stack-area').length).toBeGreaterThan(5);
    expect($('.facts-table')?.textContent).toMatch(/Demand per person/);
    // Trend for the exposure group: the % lines together.
    expect($('.trend h2')?.textContent).toMatch(/Japan · Electricity: import exposure/);
    expect($$('.trend .trend-svg path.trend-line').length).toBe(5);

    await go('#/?cat=energy&ind=owid-electricity-coal&sel=JPN', () => $('#flow-coal')?.getAttribute('aria-pressed') === 'true');
    expect($('.trend h2')?.textContent).toMatch(/Japan · Electricity: generation by source/);
    expect($$('.trend .stack-area').length).toBeGreaterThan(5); // stacked areas by source
    expect($('.trend-legend')?.textContent).toMatch(/Demand/);

    await go('#/?cat=energy&sel=BRB', () => $('.detail h2')?.textContent === 'Barbados');
    expect($('#exposure-block')?.textContent).toMatch(/Not computed: no import-dependence data for/);
    expect($$('#exposure-block .stackbar-seg.unknown').length).toBe(1);
    expect($('.detail .cat-row.status-scored .badge.missing')?.textContent).toBe('no data'); // not scored, not 0
  });

  it('compare and method views render', async () => {
    await go('#/compare?keys=USA,SGP', () => !!$('.cmp-table'));
    expect($$('.cmp-table thead th').length).toBe(3);
    expect($('.cmp-table')?.textContent).toMatch(/Electricity import exposure/);
    expect($('.cmp-table')?.textContent).toMatch(/more fuel & energy series/);
    await go('#/method', () => $$('.dataset').length === 44);
    expect($('main')?.textContent).toMatch(/PARENT-SUB/);
    expect($('#method-electricity')?.textContent).toMatch(/Electricity import exposure/);
    expect($('main')?.textContent).toMatch(/Currently scored: Fuel & energy = this exposure/);
    expect($('main')?.textContent).toMatch(/9d8efc4a9b1cc2ffdfa7f7f6f1e171b2922e0be2d97c0edf2982e874357ed6de/);
  });

  it('search filters the ranking table', async () => {
    await go('#/', () => !!$('.rank-table'));
    const input = $('#search') as HTMLInputElement;
    input.value = 'puerto';
    input.dispatchEvent(new Event('input'));
    const rows = $$('.rank-table tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toMatch(/Puerto Rico/);
  });
});
