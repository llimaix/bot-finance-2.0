/**
 * Gráficas en SVG, sin librerías. Reglas de la guía de visualización:
 * - Una sola escala Y (todas las series en quetzales).
 * - Paleta categórica oscura validada (orden fijo, nunca cíclica).
 * - Marcas finas: líneas de 2px, barras con 2px de separación y extremo
 *   redondeado de 4px anclado a la base, rejilla recesiva.
 * - Capa de hover por defecto (crosshair/tooltip), objetivos de toque
 *   mayores que la marca, leyenda + etiqueta directa y tabla accesible.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent, ReactNode, RefObject } from 'react';
import { fecha, q, qCompact } from '../format';

export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'] as const;
export const OTROS = '#6b6a66';

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e?.contentRect.width ?? 0)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Ticks "bonitos" que incluyen el 0. */
function niceScale(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max, lo + 1);
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v));
  if (ticks[ticks.length - 1]! < hi) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 80), Math.max(width - 80, 80));
  return (
    <div className="tooltip" style={{ left }} role="status">
      {children}
    </div>
  );
}

function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: Array<Array<string>> }) {
  return (
    <details className="datatable">
      <summary>Ver datos</summary>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

// ── Líneas: evolución diaria (foto SNAP#) ───────────────────────────────────

export interface LineSeries {
  label: string;
  color: string;
  values: Array<number | null>;
}

export function LineChart({ dates, series, height = 220 }: { dates: string[]; series: LineSeries[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId();
  const pad = { top: 12, right: 74, bottom: 26, left: 48 };
  const iw = Math.max(width - pad.left - pad.right, 10);
  const ih = height - pad.top - pad.bottom;

  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceScale(Math.min(...all), Math.max(...all));
  const y0 = ticks[0]!;
  const y1 = ticks[ticks.length - 1]!;
  const x = (i: number) => pad.left + (dates.length <= 1 ? iw / 2 : (i / (dates.length - 1)) * iw);
  const y = (v: number) => pad.top + ih - ((v - y0) / (y1 - y0)) * ih;

  const paths = series.map((s) => {
    let d = '';
    s.values.forEach((v, i) => {
      if (v === null) return;
      const prev = i > 0 ? s.values[i - 1] : null;
      d += `${prev === null || prev === undefined ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return d;
  });
  const first = series[0];
  const area =
    first && first.values.every((v) => v !== null)
      ? `${paths[0]}L${x(dates.length - 1)},${y(Math.max(y0, 0))}L${x(0)},${y(Math.max(y0, 0))}Z`
      : null;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.round(rel * (dates.length - 1)));
  };

  // Etiquetas directas al final, separadas para no chocar.
  const ends = series
    .map((s, i) => {
      const last = [...s.values].reverse().find((v) => v !== null);
      return last === undefined || last === null ? null : { i, y: y(last), label: s.label, color: s.color };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) {
    if (ends[k]!.y - ends[k - 1]!.y < 14) ends[k]!.y = ends[k - 1]!.y + 14;
  }

  const step = Math.max(1, Math.ceil(dates.length / Math.max(2, Math.floor(iw / 64))));

  return (
    <div className="chart" ref={ref}>
      <div className="legend" aria-hidden="true">
        {series.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Evolución de ${series.map((s) => s.label).join(', ')}`}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={first?.color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={first?.color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={pad.left + iw} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'gridline'} />
              <text x={pad.left - 8} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
                {qCompact(t)}
              </text>
            </g>
          ))}
          {dates.map((d, i) =>
            i % step === 0 || i === dates.length - 1 ? (
              <text key={d} x={x(i)} y={height - 6} className="tick" textAnchor="middle">
                {fecha(d)}
              </text>
            ) : null,
          )}
          {area && <path d={area} fill={`url(#${gradId})`} />}
          {series.map((s, i) => (
            <path key={s.label} d={paths[i]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {ends.map((e) => (
            <g key={e.label}>
              <text x={pad.left + iw + 10} y={e.y} className="direct" dominantBaseline="middle">
                {e.label}
              </text>
            </g>
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + ih} className="crosshair" />
              {series.map((s) => {
                const v = s.values[hover];
                return v === null || v === undefined ? null : (
                  <circle key={s.label} cx={x(hover)} cy={y(v)} r={4.5} fill={s.color} className="dot" />
                );
              })}
            </g>
          )}
          <rect
            x={pad.left}
            y={pad.top}
            width={iw}
            height={ih}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {hover !== null && dates[hover] && (
        <Tooltip x={x(hover)} width={width}>
          <strong>{fecha(dates[hover])}</strong>
          {series.map((s) => (
            <span key={s.label} className="tt-row">
              <i style={{ background: s.color }} />
              {s.label}
              <b>{s.values[hover] === null || s.values[hover] === undefined ? '—' : q(s.values[hover]!)}</b>
            </span>
          ))}
        </Tooltip>
      )}
      <DataTable
        caption="Evolución diaria"
        head={['Fecha', ...series.map((s) => s.label)]}
        rows={dates.map((d, i) => [fecha(d), ...series.map((s) => (s.values[i] === null ? '—' : q(s.values[i]!)))])}
      />
    </div>
  );
}

// ── Barras: gasto por día del mes ───────────────────────────────────────────

export function DailyBars({ data, height = 190 }: { data: Array<{ fecha: string; monto: number }>; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 14, right: 8, bottom: 24, left: 44 };
  const iw = Math.max(width - pad.left - pad.right, 10);
  const ih = height - pad.top - pad.bottom;
  const max = Math.max(...data.map((d) => d.monto), 1);
  const ticks = niceScale(0, max, 3);
  const top = ticks[ticks.length - 1]!;
  const slot = iw / Math.max(data.length, 1);
  const bw = Math.max(Math.min(slot - 2, 22), 2);
  const y = (v: number) => pad.top + ih - (v / top) * ih;
  const avg = data.length ? data.reduce((a, d) => a + d.monto, 0) / data.length : 0;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 34))));

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Gasto por día del mes">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={pad.left + iw} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'gridline'} />
              <text x={pad.left - 8} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
                {qCompact(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = pad.left + slot * i + slot / 2;
            const h = Math.max(ih - (y(d.monto) - pad.top), d.monto > 0 ? 2 : 0);
            const r = Math.min(4, bw / 2, h);
            const x0 = cx - bw / 2;
            const yb = pad.top + ih;
            // Extremo superior redondeado, base recta anclada al eje.
            const path =
              h > 0
                ? `M${x0},${yb}V${yb - h + r}Q${x0},${yb - h} ${x0 + r},${yb - h}H${x0 + bw - r}Q${x0 + bw},${yb - h} ${x0 + bw},${yb - h + r}V${yb}Z`
                : '';
            return (
              <g key={d.fecha}>
                {path && <path d={path} fill={SERIES[0]} opacity={hover === null || hover === i ? 1 : 0.45} />}
                {(i % labelEvery === 0 || i === data.length - 1) && (
                  <text x={cx} y={height - 6} className="tick" textAnchor="middle">
                    {Number(d.fecha.slice(8, 10))}
                  </text>
                )}
                <rect
                  x={pad.left + slot * i}
                  y={pad.top}
                  width={slot}
                  height={ih}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerDown={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                />
              </g>
            );
          })}
          {avg > 0 && (
            <g pointerEvents="none">
              <line x1={pad.left} x2={pad.left + iw} y1={y(avg)} y2={y(avg)} className="avg" />
              <text x={pad.left + iw} y={y(avg) - 5} className="direct" textAnchor="end">
                Promedio {qCompact(avg)}
              </text>
            </g>
          )}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <Tooltip x={pad.left + slot * hover + slot / 2} width={width}>
          <strong>{fecha(data[hover].fecha)}</strong>
          <span className="tt-row">
            Gasto <b>{q(data[hover].monto)}</b>
          </span>
        </Tooltip>
      )}
      <DataTable caption="Gasto por día" head={['Día', 'Gasto']} rows={data.map((d) => [fecha(d.fecha), q(d.monto)])} />
    </div>
  );
}

// ── Dona: gasto por categoría ───────────────────────────────────────────────

export interface Slice {
  label: string;
  emoji: string;
  value: number;
  color: string;
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const;
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0},${y0}A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`;
}

export function Donut({ slices, total, size = 188 }: { slices: Slice[]; total: number; size?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const stroke = 22;
  const r = (size - stroke) / 2 - 2;
  const c = size / 2;
  const sum = slices.reduce((a, s) => a + s.value, 0) || 1;
  const arcs = useMemo(() => {
    let a = 0;
    return slices.map((s) => {
      const span = (s.value / sum) * Math.PI * 2;
      const res = { a0: a, a1: a + span };
      a += span;
      return res;
    });
  }, [slices, sum]);
  const sel = active === null ? null : slices[active];

  return (
    <div className="donut-wrap">
      <svg width={size} height={size} role="img" aria-label="Gasto por categoría" className="donut">
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--grid)" strokeWidth={stroke} />
        {slices.map((s, i) => {
          const { a0, a1 } = arcs[i]!;
          const full = a1 - a0 >= Math.PI * 2 - 1e-6;
          return full ? (
            <circle key={s.label} cx={c} cy={c} r={r} fill="none" stroke={s.color} strokeWidth={stroke} />
          ) : (
            <path
              key={s.label}
              d={arc(c, c, r, a0, a1)}
              fill="none"
              stroke={s.color}
              strokeWidth={active === i ? stroke + 4 : stroke}
              opacity={active === null || active === i ? 1 : 0.4}
              onPointerEnter={() => setActive(i)}
              onPointerDown={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
            />
          );
        })}
        {/* Separación de 2px entre segmentos (color de superficie). */}
        {slices.length > 1 &&
          arcs.map(({ a0 }, i) => (
            <line
              key={i}
              x1={c + (r - stroke / 2 - 3) * Math.sin(a0)}
              y1={c - (r - stroke / 2 - 3) * Math.cos(a0)}
              x2={c + (r + stroke / 2 + 3) * Math.sin(a0)}
              y2={c - (r + stroke / 2 + 3) * Math.cos(a0)}
              stroke="var(--surface)"
              strokeWidth={2}
              pointerEvents="none"
            />
          ))}
        <text x={c} y={c - 6} textAnchor="middle" className="donut-value">
          {sel ? `${Math.round((sel.value / sum) * 100)}%` : qCompact(total)}
        </text>
        <text x={c} y={c + 14} textAnchor="middle" className="donut-label">
          {sel ? sel.label : 'este mes'}
        </text>
      </svg>
      <ul className="slices">
        {slices.map((s, i) => (
          <li
            key={s.label}
            className={active === i ? 'on' : undefined}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
          >
            <i style={{ background: s.color }} />
            <span className="slice-name">
              {s.emoji} {s.label}
            </span>
            <span className="slice-pct">{Math.round((s.value / sum) * 100)}%</span>
            <b>{q(s.value)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Barra de progreso (tarjetas y metas) ────────────────────────────────────

export function Progress({ value, tone }: { value: number; tone: 'good' | 'warning' | 'serious' | 'critical' | 'neutral' }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <span className={`fill ${tone}`} style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
    </div>
  );
}
