import { geoEqualEarth, geoPath } from 'd3-geo';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, Geometry } from 'geojson';
import type { Entity } from '../lib/types';
import { el } from './format';

export interface Metric {
  kind: 'score' | 'raw';
  label: string;
  unit: string;
  get(key: string): number | null;
  color(v: number): string;
  /** For the legend. */
  domain: [number, number];
  ticks: { v: number; label: string }[];
  formula: string;
  /** Legend gradient stops (left to right) when the scale is not linear/log in value space (e.g. symlog, diverging). */
  gradient?: string[];
  /** Year and source flag of each entity's value (raw metrics). */
  yearOf?(key: string): number | undefined;
  flagOf?(key: string): string | undefined;
}

type F = Feature<Geometry, { name: string }> & { id?: string };

export interface MapView {
  update(metric: Metric | null, selected: string | undefined, describe: (key: string | undefined, name: string) => string): void;
}

/** Choropleth world map. Countries are joined to entities via ISO 3166-1 numeric ids (Kosovo by name). */
export function createMap(container: HTMLElement, topo: unknown, entities: Entity[], onSelect: (key: string) => void): MapView {
  const t = topo as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  const fc = feature(t, t.objects.countries) as unknown as { features: F[] };
  const byNumeric = new Map(entities.filter((e) => e.numeric).map((e) => [e.numeric!, e.key]));
  const keyOf = (f: F): string | undefined => (f.id ? byNumeric.get(String(f.id)) : f.properties.name === 'Kosovo' ? 'XKX' : undefined);

  const width = 960, height = 500;
  const projection = geoEqualEarth().fitExtent([[4, 4], [width - 4, height - 4]], { type: 'Sphere' } as never);
  const path = geoPath(projection);

  const tooltip = el('div', { class: 'map-tooltip', role: 'status', 'aria-live': 'polite' });
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  container.replaceChildren(svgEl, tooltip);
  const svg = select(svgEl)
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('role', 'img')
    .attr('aria-label', 'World map. Use the ranking table below for an accessible list of the same values.')
    .attr('class', 'map-svg');
  const defs = svg.append('defs');
  defs.append('pattern').attr('id', 'hatch').attr('patternUnits', 'userSpaceOnUse').attr('width', 6).attr('height', 6)
    .attr('patternTransform', 'rotate(45)')
    .call((p) => { p.append('rect').attr('width', 6).attr('height', 6).attr('class', 'hatch-bg'); p.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6).attr('class', 'hatch-line'); });
  const g = svg.append('g');
  g.append('path').datum({ type: 'Sphere' } as never).attr('class', 'sphere').attr('d', path as never);
  const countries = g.append('g').selectAll<SVGPathElement, F>('path').data(fc.features).join('path')
    .attr('class', 'country')
    .attr('d', (d) => path(d) ?? '')
    .attr('data-key', (d) => keyOf(d) ?? '');

  const z: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>().scaleExtent([1, 12])
    .translateExtent([[0, 0], [width, height]])
    .on('zoom', (ev) => { g.attr('transform', ev.transform.toString()); g.style('--zoom', String(ev.transform.k)); });
  svg.call(z);
  const controls = el('div', { class: 'map-controls' },
    el('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => svg.call(z.scaleBy, 1.6) }, '+'),
    el('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => svg.call(z.scaleBy, 1 / 1.6) }, '−'),
    el('button', { type: 'button', 'aria-label': 'Reset zoom', onclick: () => svg.call(z.transform, zoomIdentity) }, '⟲'),
  );
  container.append(controls);

  let describe: (key: string | undefined, name: string) => string = (_k, n) => n;
  countries
    .on('mousemove', (ev: MouseEvent, d) => {
      const r = container.getBoundingClientRect();
      tooltip.textContent = describe(keyOf(d), d.properties.name);
      tooltip.style.left = `${ev.clientX - r.left + 12}px`;
      tooltip.style.top = `${ev.clientY - r.top + 12}px`;
      tooltip.classList.add('show');
    })
    .on('mouseleave', () => tooltip.classList.remove('show'))
    .on('click', (_ev, d) => { const k = keyOf(d); if (k) onSelect(k); });

  return {
    update(metric, selected, desc) {
      describe = desc;
      countries
        .attr('fill', (d) => {
          const k = keyOf(d);
          const v = k && metric ? metric.get(k) : null;
          return v == null ? 'url(#hatch)' : metric!.color(v);
        })
        .classed('selected', (d) => !!selected && keyOf(d) === selected);
      countries.filter('.selected').raise();
    },
  };
}

export function legend(metric: Metric | null): HTMLElement {
  const box = el('div', { class: 'legend' });
  if (!metric) return box;
  const stops = metric.gradient ? metric.gradient.map((c, i, all) => `${c} ${Math.round((100 * i) / (all.length - 1))}%`) : Array.from({ length: 11 }, (_, i) => {
    const [a, b] = metric.domain;
    const v = metric.kind === 'raw' && a > 0 ? Math.exp(Math.log(a) + (i / 10) * (Math.log(b) - Math.log(a))) : a + (i / 10) * (b - a);
    return `${metric.color(v)} ${i * 10}%`;
  });
  box.append(
    el('div', { class: 'legend-title' }, metric.label),
    el('div', { class: 'legend-row' },
      el('div', { class: 'legend-bar', style: `background: linear-gradient(to right, ${stops.join(',')})`, 'aria-hidden': 'true' }),
      el('span', { class: 'legend-missing' }, el('span', { class: 'swatch-missing', 'aria-hidden': 'true' }), 'No data'),
    ),
    el('div', { class: 'legend-ticks', 'aria-hidden': 'true' }, ...metric.ticks.map((t) => el('span', {}, t.label))),
  );
  return box;
}
