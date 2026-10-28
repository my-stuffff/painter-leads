import { clsx } from 'clsx';
import { geoBounds, geoConicConformal, geoPath } from 'd3-geo';
import type { ExtendedFeature } from 'd3-geo';
import { useMemo } from 'react';
import { feature } from 'topojson-client';
import statesTopo from 'us-atlas/states-10m.json';
import type { CatalogCity, StateCode } from '../../../shared/api';
import { compactPop } from '../../lib/format';

const FIPS: Record<StateCode, string> = { CA: '06', TX: '48', NJ: '34' };
const W = 280;
const H = 200;
const PAD = 14;

type Topo = Parameters<typeof feature>[0];
const topo = statesTopo as unknown as Topo;
let shapes: Map<string, ExtendedFeature> | null = null;
function stateShape(code: StateCode): ExtendedFeature | undefined {
  if (!shapes) {
    const fc = feature(topo, (topo.objects as Record<string, Parameters<typeof feature>[1]>).states as never) as unknown as {
      features: ExtendedFeature[];
    };
    shapes = new Map(fc.features.map((f) => [String(f.id), f]));
  }
  return shapes.get(FIPS[code]);
}

/** Real outline of a state (us-atlas) with its catalog cities as dots sized by population. */
export function StateMap({
  code,
  cities,
  picked,
  active,
  maxPop,
  onToggleCity,
}: {
  code: StateCode;
  cities: CatalogCity[];
  picked: Set<string>;
  active: boolean;
  maxPop: number;
  onToggleCity: (areaId: string) => void;
}) {
  const geo = useMemo(() => {
    const f = stateShape(code);
    if (!f) return null;
    const [[x0, y0], [x1, y1]] = geoBounds(f);
    const proj = geoConicConformal()
      .parallels([y0 + (y1 - y0) / 6, y1 - (y1 - y0) / 6])
      .rotate([-(x0 + x1) / 2, 0])
      .fitExtent(
        [
          [PAD, PAD],
          [W - PAD, H - PAD],
        ],
        f,
      );
    return { d: geoPath(proj)(f) ?? '', proj };
  }, [code]);

  const dots = useMemo(() => {
    if (!geo) return [];
    const placed = cities.flatMap((c) => {
      const p = geo.proj([c.lng, c.lat]);
      if (!p) return [];
      return [{ c, x: p[0], y: p[1], r: 2.6 + 7 * Math.sqrt(c.population / maxPop) }];
    });
    // Name the biggest cities, each label on the first side where it overlaps nothing (dots or other labels).
    const boxes = placed.map((d) => ({ x0: d.x - d.r, y0: d.y - d.r, x1: d.x + d.r, y1: d.y + d.r }));
    const labels = new Map<string, { x: number; y: number; anchor: 'start' | 'end' | 'middle' }>();
    const biggest = [...placed].sort((p1, p2) => p2.c.population - p1.c.population).slice(0, code === 'NJ' ? 1 : 3);
    for (const d of biggest) {
      const w = d.c.name.length * 5.9;
      const h = 11;
      const options = [
        { x: d.x + d.r + 4, y: d.y + 3.5, anchor: 'start' as const, box: { x0: d.x + d.r + 3, x1: d.x + d.r + 5 + w, y0: d.y - h / 2, y1: d.y + h / 2 } },
        { x: d.x - d.r - 4, y: d.y + 3.5, anchor: 'end' as const, box: { x0: d.x - d.r - 5 - w, x1: d.x - d.r - 3, y0: d.y - h / 2, y1: d.y + h / 2 } },
        { x: d.x, y: d.y + d.r + 11, anchor: 'middle' as const, box: { x0: d.x - w / 2, x1: d.x + w / 2, y0: d.y + d.r + 1, y1: d.y + d.r + 13 } },
        { x: d.x, y: d.y - d.r - 4, anchor: 'middle' as const, box: { x0: d.x - w / 2, x1: d.x + w / 2, y0: d.y - d.r - 15, y1: d.y - d.r - 2 } },
      ];
      const own = { x0: d.x - d.r, y0: d.y - d.r, x1: d.x + d.r, y1: d.y + d.r };
      const ok = options.find(
        (o) =>
          o.box.x0 >= 2 &&
          o.box.x1 <= W - 2 &&
          o.box.y0 >= 0 &&
          o.box.y1 <= H &&
          !boxes.some(
            (bx) =>
              !(bx.x0 === own.x0 && bx.y0 === own.y0) &&
              !(bx.x1 <= o.box.x0 || bx.x0 >= o.box.x1 || bx.y1 <= o.box.y0 || bx.y0 >= o.box.y1),
          ),
      );
      if (!ok) continue;
      boxes.push(ok.box);
      labels.set(d.c.areaId, { x: ok.x, y: ok.y, anchor: ok.anchor });
    }
    return placed
      .sort((p1, p2) => p1.c.population - p2.c.population) // big dots drawn last (on top)
      .map((d) => ({ ...d, label: labels.get(d.c.areaId) ?? null }));
  }, [geo, cities, maxPop, code]);

  if (!geo) return <div className="aspect-[7/5] w-full" />;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block aspect-[7/5] w-full" role="img" aria-label={`Map of ${code} with ${cities.length} cities`}>
      <path
        d={geo.d}
        className={clsx(
          'transition-[fill,stroke] duration-200',
          active ? 'fill-tint stroke-accent/70' : 'fill-raised stroke-line-strong',
        )}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <g>
        {dots.map(({ c, x, y, r }) => {
          const on = picked.has(c.areaId);
          return (
            <circle
              key={c.areaId}
              cx={x}
              cy={y}
              r={r}
              onClick={(e) => {
                e.stopPropagation();
                onToggleCity(c.areaId);
              }}
              className={clsx(
                'cursor-pointer transition-[fill,stroke,opacity] duration-150',
                on ? 'fill-brand stroke-surface' : active ? 'fill-surface stroke-accent hover:fill-tint' : 'fill-surface stroke-ink-3/70',
              )}
              strokeWidth={on ? 1.6 : 1.3}
            >
              <title>
                {c.name}: {compactPop(c.population)} people, {c.zipCount} ZIP codes
              </title>
            </circle>
          );
        })}
      </g>
      <g className="pointer-events-none max-[479px]:hidden" aria-hidden>
        {dots
          .flatMap(({ c, label }) => (label ? [{ c, label }] : []))
          .map(({ c, label }) => {
            return (
              <text
                key={c.areaId}
                x={label.x}
                y={label.y}
                textAnchor={label.anchor}
                className={clsx('text-[10.5px] font-medium', active ? 'fill-ink-2' : 'fill-ink-3')}
                style={{ paintOrder: 'stroke', stroke: 'var(--surface)', strokeWidth: 3, strokeLinejoin: 'round' }}
              >
                {c.name}
              </text>
            );
          })}
      </g>
    </svg>
  );
}
