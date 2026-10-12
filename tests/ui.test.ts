// @vitest-environment jsdom
/** UI smoke test: boots the real app against public/data (prepared by `npm test`) in jsdom. */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const until = async (fn: () => boolean, ms = 4000) => {
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
    await go('#/?cat=energy', () => !!$('.banner.need'));
    expect($$('path.country').every((p) => p.getAttribute('fill') === 'url(#hatch)')).toBe(true);
    expect($('#need-energy')?.textContent).toMatch(/EG\.IMP\.CONS\.ZS/);
  });

  it('compare and method views render', async () => {
    await go('#/compare?keys=USA,SGP', () => !!$('.cmp-table'));
    expect($$('.cmp-table thead th').length).toBe(3);
    await go('#/method', () => $$('.dataset').length === 2);
    expect($('main')?.textContent).toMatch(/PARENT-SUB/);
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
