import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * p;
}

/** Rounded-top bar path anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export interface StackDatum {
  key: string;
  label: string; // axis label (may be blank to thin labels)
  base: number; // primary series (e.g. on-time)
  top: number; // secondary series stacked on top (e.g. late)
  tip: ReactNode;
}

/**
 * Stacked two-series bar chart (primary + secondary) with per-bar hover/focus tooltip.
 * Legend is provided by the caller; identity is never color-alone (legend + tooltip text).
 */
export function StackedBars({ data, height = 180, label, baseClass = 'bar', topClass = 'bar-late', yFormat = (v: number) => String(v) }: {
  data: StackDatum[]; height?: number; label: string; baseClass?: string; topClass?: string; yFormat?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const padL = 30;
  const padB = 22;
  const padT = 8;
  const innerW = Math.max(0, width - padL);
  const innerH = height - padB - padT;
  const max = niceMax(Math.max(0, ...data.map((d) => d.base + d.top)));
  const step = data.length ? innerW / data.length : 0;
  const bw = Math.max(2, Math.min(28, step * 0.62));
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(innerW / 44))));
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const cur = active !== null ? data[active] : null;
  return (
    <div ref={ref} className="stack-sm">
      <div className="chart-tip" aria-live="polite">{cur ? cur.tip : ' '}</div>
      {width > 0 && (
        <svg className="chart" width={width} height={height} role="img" aria-label={label} onMouseLeave={() => setActive(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={padL} x2={width} y1={y(t)} y2={y(t)} />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end">{yFormat(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + step * i + step / 2;
            const x = cx - bw / 2;
            const hb = (d.base / max) * innerH;
            const ht = (d.top / max) * innerH;
            const gap = d.base > 0 && d.top > 0 ? 2 : 0;
            return (
              <g key={d.key} className="col" opacity={active !== null && active !== i ? 0.55 : 1}>
                {/* Larger invisible hit target */}
                <rect x={padL + step * i} y={padT} width={step} height={innerH} fill="transparent" onMouseEnter={() => setActive(i)} onClick={() => setActive(i)} />
                {d.top <= 0 ? (
                  <path className={baseClass} d={barPath(x, y(d.base), bw, hb, 4)} pointerEvents="none" />
                ) : (
                  <>
                    <rect className={baseClass} x={x} y={y(d.base)} width={bw} height={Math.max(0, hb)} pointerEvents="none" />
                    <path className={topClass} d={barPath(x, y(d.base + d.top), bw, Math.max(0, ht - gap), 4)} pointerEvents="none" />
                  </>
                )}
                {d.label && i % labelEvery === 0 && (
                  <text x={cx} y={height - 6} textAnchor="middle">{d.label}</text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {/* Keyboard access to the same values */}
      <div className="sr-only">
        <ul>
          {data.map((d) => (
            <li key={d.key}>{d.tip}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Single-series line chart (e.g. worked hours per week) with hover crosshair. */
export function LineChart({ points, height = 140, label, yFormat = (v: number) => String(v) }: {
  points: { key: string; label: string; value: number; tip: ReactNode }[]; height?: number; label: string; yFormat?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const padL = 34;
  const padR = 8;
  const padB = 22;
  const padT = 10;
  const innerW = Math.max(0, width - padL - padR);
  const innerH = height - padB - padT;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const x = (i: number) => padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = points.length ? `${d}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z` : '';
  const cur = active !== null ? points[active] : null;
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(innerW / 56))));
  return (
    <div ref={ref} className="stack-sm">
      <div className="chart-tip" aria-live="polite">{cur ? cur.tip : ' '}</div>
      {width > 0 && (
        <svg className="chart" width={width} height={height} role="img" aria-label={label} onMouseLeave={() => setActive(null)}>
          {[0, max / 2, max].map((t) => (
            <g key={t}>
              <line className="grid-line" x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end">{yFormat(t)}</text>
            </g>
          ))}
          <path className="area" d={area} opacity={0.7} />
          <path className="line" d={d} />
          {active !== null && <line className="grid-line" x1={x(active)} x2={x(active)} y1={padT} y2={padT + innerH} strokeDasharray="3 3" />}
          {points.map((p, i) => (
            <g key={p.key}>
              <rect x={x(i) - innerW / Math.max(1, points.length) / 2} y={padT} width={Math.max(8, innerW / Math.max(1, points.length))} height={innerH} fill="transparent" onMouseEnter={() => setActive(i)} onClick={() => setActive(i)} />
              {(active === i || points.length <= 12) && <circle className="dot-pt" cx={x(i)} cy={y(p.value)} r={active === i ? 5 : 3.5} pointerEvents="none" />}
              {i % labelEvery === 0 && <text x={x(i)} y={height - 6} textAnchor="middle">{p.label}</text>}
            </g>
          ))}
        </svg>
      )}
      <div className="sr-only">
        <ul>
          {points.map((p) => (
            <li key={p.key}>{p.tip}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; className: string }[] }) {
  return (
    <div className="chart-legend">
      {items.map((i) => (
        <span key={i.label}>
          <i className={`lg-${i.className}`} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function Meter({ value, tone }: { value: number | null; tone?: 'warning' | 'success' }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className={`meter ${tone ? `tone-${tone}` : ''}`} role="presentation">
      <i style={{ width: `${v}%` }} />
    </div>
  );
}
