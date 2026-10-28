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
    const sorted = [...cities].sort((a, b) => a.population - b.population); // big dots drawn last (on top)
    const labelled = new Set(
      [...cities]
        .sort((a, b) => b.population - a.population)
        .slice(0, code === 'NJ' ? 1 : 2)
        .map((c) => c.areaId),
    );
    return sorted.flatMap((c) => {
      const p = geo.proj([c.lng, c.lat]);
      if (!p) return [];
      const r = 2.6 + 7 * Math.sqrt(c.population / maxPop);
      return [{ c, x: p[0], y: p[1], r, label: labelled.has(c.areaId) }];
    });
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
      <g className="pointer-events-none" aria-hidden>
        {dots
          .filter((d) => d.label)
          .map(({ c, x, y, r }) => {
            const left = x > W * 0.66;
            return (
              <text
                key={c.areaId}
                x={left ? x - r - 4 : x + r + 4}
                y={y + 3.5}
                textAnchor={left ? 'end' : 'start'}
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
