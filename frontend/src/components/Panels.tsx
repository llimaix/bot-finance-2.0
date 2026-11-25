/** Paneles del dashboard: cada uno recibe su parte del contrato y nada más. */
import type { ReactNode } from 'react';
import type { Dashboard } from '../api';
import { capitalizar, fecha, mesLargo, pct, plural, q, q0 } from '../format';
import { DailyBars, Donut, LineChart, OTROS, Progress, SERIES } from './Charts';
import {
  Alert,
  ArrowDownLeft,
  ArrowUpRight,
  Bank,
  Bars,
  Calendar,
  Card,
  Cash,
  Check,
  Clock,
  Flame,
  LineChart as LineIcon,
  List,
  Phone,
  Pie,
  Sparkles,
  Swap,
  Target,
  TrendDown,
  TrendUp,
  Wallet,
} from './Icons';

export function Section({ icon, title, aside, children, className }: { icon: ReactNode; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className ?? ''}`}>
      <header className="panel-head">
        <span className="panel-icon">{icon}</span>
        <h2>{title}</h2>
        {aside && <span className="panel-aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

const diasHasta = (hoy: string, f: string) =>
  Math.round((Date.parse(`${f}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);

const enDias = (n: number) => (n === 0 ? 'hoy' : n === 1 ? 'mañana' : n < 0 ? `hace ${plural(-n, 'día', 'días')}` : `en ${plural(n, 'día', 'días')}`);

// ── Hero: libre hasta el próximo ingreso ────────────────────────────────────

export function Hero({ d }: { d: Dashboard }) {
  const r = d.resumen;
  const ok = r.libre === null || r.libre >= 0;
  return (
    <section className={`hero ${ok ? '' : 'hero-neg'}`}>
      <div className="hero-top">
        <span className="chip">
          <Sparkles size={14} /> Libre hasta tu próximo ingreso
        </span>
      </div>
      {r.libre === null ? (
        <>
          <p className="hero-value">{q0(r.disponible)}</p>
          <p className="hero-sub">Disponible hoy. Dile al bot cuándo te pagan para calcular tu libre.</p>
        </>
      ) : (
        <>
          <p className="hero-value">{q0(r.libre)}</p>
          {r.proximoIngreso && (
            <p className="hero-sub">
              <Calendar size={14} /> {r.proximoIngreso.descripcion} · {fecha(r.proximoIngreso.fecha)} · {enDias(r.proximoIngreso.dias)}
            </p>
          )}
          {r.libreDespues !== null && r.proximoIngreso && (
            <p className="hero-after">
              Después de recibir {q0(r.proximoIngreso.monto)}: <b>~{q0(r.libreDespues)}</b> libre
            </p>
          )}
        </>
      )}
      <div className="hero-stats">
        <Stat icon={<Wallet size={16} />} label="Disponible" value={q(r.disponible)} />
        <Stat icon={<Card size={16} />} label="Tarjetas" value={q(r.deuda)} />
        {r.prestamos > 0 && <Stat icon={<Bank size={16} />} label="Préstamos" value={q(r.prestamos)} />}
        <Stat icon={<TrendUp size={16} />} label="Neto" value={q(r.neto)} />
      </div>
    </section>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">
        {icon}
        {label}
      </span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

// ── KPIs del mes ────────────────────────────────────────────────────────────

export function Kpis({ d }: { d: Dashboard }) {
  const g = d.gastoMes;
  const prev = g.totalMesAnteriorMismoDia;
  const delta = prev > 0 ? ((g.total - prev) / prev) * 100 : null;
  const menos = delta !== null && delta <= 0;
  const proxPago = [...d.tarjetas].filter((t) => t.pendiente > 0).sort((a, b) => a.fechaPago.localeCompare(b.fechaPago))[0];
  return (
    <div className="kpis">
      <div className="kpi">
        <span className="kpi-label">
          <Flame size={16} /> Gasto de {mesLargo(g.mes)}
        </span>
        <span className="kpi-value">{q0(g.total)}</span>
        {delta !== null && (
          <span className={`delta ${menos ? 'good' : 'bad'}`}>
            {menos ? <TrendDown size={14} /> : <TrendUp size={14} />}
            {pct(Math.abs(delta))} {menos ? 'menos' : 'más'} que el mes pasado a esta fecha
          </span>
        )}
      </div>
      <div className="kpi">
        <span className="kpi-label">
          <LineIcon size={16} /> Proyección a fin de mes
        </span>
        <span className="kpi-value">{q0(g.proyeccion)}</span>
        <span className="kpi-note">Al ritmo actual de gasto</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">
          <Clock size={16} /> Próximo pago de tarjeta
        </span>
        {proxPago ? (
          <>
            <span className="kpi-value">{q0(proxPago.pendiente)}</span>
            <span className="kpi-note">
              {proxPago.nombre} · {fecha(proxPago.fechaPago)} · {enDias(diasHasta(d.hoy, proxPago.fechaPago))}
            </span>
          </>
        ) : (
          <>
            <span className="kpi-value muted-value">Al día</span>
            <span className="kpi-note">
              <Check size={14} /> Sin pagos pendientes de corte
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Evolución (fotos diarias) ───────────────────────────────────────────────

export function Evolucion({ d }: { d: Dashboard }) {
  const h = d.historial;
  return (
    <Section icon={<LineIcon />} title="Evolución" aside={h.length > 0 ? `${plural(h.length, 'día', 'días')}` : undefined} className="span-2">
      {h.length < 2 ? (
        <Empty icon={<LineIcon size={28} />} text="La gráfica se llena sola: el guardián toma una foto de tus cifras cada mañana." />
      ) : (
        <LineChart
          dates={h.map((x) => x.fecha)}
          series={[
            { label: 'Libre', color: SERIES[0], values: h.map((x) => x.libre) },
            { label: 'Disponible', color: SERIES[1], values: h.map((x) => x.disponible) },
            { label: 'Deuda', color: SERIES[2], values: h.map((x) => x.deuda) },
          ]}
        />
      )}
    </Section>
  );
}

// ── Gasto por día y por categoría ───────────────────────────────────────────

export function GastoDiario({ d }: { d: Dashboard }) {
  return (
    <Section icon={<Bars />} title="Gasto por día" aside={capitalizar(mesLargo(d.gastoMes.mes))}>
      {d.gastoMes.total === 0 ? <Empty icon={<Bars size={28} />} text="Aún no hay gastos este mes." /> : <DailyBars data={d.gastoMes.porDia} />}
    </Section>
  );
}

export function Categorias({ d }: { d: Dashboard }) {
  const slices = d.gastoMes.porCategoria.map((c, i) => ({
    label: capitalizar(c.categoria),
    emoji: c.emoji,
    value: c.monto,
    color: c.categoria === 'otros' ? OTROS : SERIES[i % SERIES.length]!,
  }));
  return (
    <Section icon={<Pie />} title="En qué se va">
      {slices.length === 0 ? <Empty icon={<Pie size={28} />} text="Sin gastos registrados este mes." /> : <Donut slices={slices} total={d.gastoMes.total} />}
    </Section>
  );
}

// ── Tarjetas ────────────────────────────────────────────────────────────────

const tonoUso = (p: number) => (p >= 100 ? 'critical' : p > 80 ? 'serious' : p > 50 ? 'warning' : 'good');

export function Tarjetas({ d }: { d: Dashboard }) {
  if (d.tarjetas.length === 0) return null;
  return (
    <Section icon={<Card />} title="Tarjetas" aside={plural(d.tarjetas.length, 'tarjeta', 'tarjetas')}>
      <ul className="cards">
        {d.tarjetas.map((t) => {
          const dPago = diasHasta(d.hoy, t.fechaPago);
          const vencida = t.pendiente > 0 && dPago < 0;
          return (
            <li key={t.id} className="ccard">
              <div className="ccard-top">
                <span className="ccard-name">
                  <Card size={18} /> {t.nombre}
                  {t.terminaciones.length > 0 && <span className="mono"> ••{t.terminaciones[0]}</span>}
                </span>
                <span className="ccard-debt">{q(t.deudaActual)}</span>
              </div>
              <Progress value={t.usoPct} tone={tonoUso(t.usoPct)} />
              <div className="ccard-meta">
                <span>
                  {pct(t.usoPct)} de {q0(t.limite)}
                </span>
                <span>Corte {fecha(t.proximoCorte)}</span>
              </div>
              {t.pendiente > 0 ? (
                <div className={`notice ${vencida ? 'critical' : dPago <= 3 ? 'warning' : ''}`}>
                  {vencida ? <Alert size={16} /> : <Clock size={16} />}
                  <span>
                    {vencida ? 'Venció' : 'Pagar'} <b>{q(t.pendiente)}</b> {vencida ? 'el' : 'antes del'} {fecha(t.fechaPago)}
                    {!vencida && ` · ${enDias(dPago)}`}
                    {t.interesEstimado !== null && <em> · interés si no pagas: ~{q(t.interesEstimado)}</em>}
                  </span>
                </div>
              ) : (
                <div className="notice good">
                  <Check size={16} />
                  <span>Pago del corte cubierto · este periodo: {q(t.consumoPeriodo)}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ── Metas ───────────────────────────────────────────────────────────────────

const META = {
  verde: { tone: 'good', label: 'En ritmo', Icon: Check },
  amarillo: { tone: 'warning', label: 'Ritmo alto', Icon: Clock },
  rojo: { tone: 'critical', label: 'Superada', Icon: Alert },
} as const;

export function Metas({ d }: { d: Dashboard }) {
  if (d.metas.length === 0) return null;
  return (
    <Section icon={<Target />} title="Metas del mes">
      <ul className="metas">
        {d.metas.map((m) => {
          const s = META[m.estado];
          return (
            <li key={m.categoria}>
              <div className="meta-top">
                <span>
                  {m.emoji} {capitalizar(m.categoria)}
                </span>
                <span className={`badge ${s.tone}`}>
                  <s.Icon size={13} /> {s.label}
                </span>
              </div>
              <Progress value={m.pct} tone={s.tone} />
              <div className="meta-bottom">
                <span>
                  {q0(m.gastado)} de {q0(m.limite)}
                </span>
                <b>{pct(m.pct)}</b>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ── Cuentas ─────────────────────────────────────────────────────────────────

const ICONO_CUENTA = { banco: Bank, efectivo: Cash, billetera: Phone } as const;

export function Cuentas({ d }: { d: Dashboard }) {
  if (d.cuentas.length === 0) return null;
  const total = d.cuentas.reduce((a, c) => a + Math.max(c.saldo, 0), 0) || 1;
  return (
    <Section icon={<Wallet />} title="Cuentas" aside={q0(d.resumen.disponible)}>
      <ul className="accounts">
        {d.cuentas.map((c) => {
          const Icon = ICONO_CUENTA[c.tipo] ?? Bank;
          return (
            <li key={c.id}>
              <span className="acc-icon">
                <Icon size={18} />
              </span>
              <span className="acc-name">
                {c.nombre}
                {c.terminaciones.length > 0 && <span className="mono"> ••{c.terminaciones[0]}</span>}
                <span className="acc-share" style={{ width: `${(Math.max(c.saldo, 0) / total) * 100}%` }} />
              </span>
              <b className={c.saldo < 0 ? 'neg' : undefined}>{q(c.saldo)}</b>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ── Préstamos ───────────────────────────────────────────────────────────────

export function Prestamos({ d }: { d: Dashboard }) {
  if (d.prestamos.length === 0) return null;
  return (
    <Section icon={<Bank />} title="Préstamos" aside={q0(d.resumen.prestamos)}>
      <ul className="accounts">
        {d.prestamos.map((p) => {
          const detalle = [
            ...(p.cuota !== null ? [`cuota ${q(p.cuota)}`] : []),
            ...(p.diaPago !== null ? [`el ${p.diaPago}`] : []),
            ...(p.vence !== null ? [`vence ${fecha(p.vence)} ${p.vence.slice(0, 4)}`] : []),
          ].join(' · ');
          return (
            <li key={p.id}>
              <span className="acc-icon">
                <Bank size={18} />
              </span>
              <span className="acc-name">
                {p.nombre}
                {detalle && <span className="acc-detail"> · {detalle}</span>}
              </span>
              <b className="neg">{q(p.deuda)}</b>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ── Movimientos ─────────────────────────────────────────────────────────────

const TIPO = {
  gasto: { Icon: ArrowUpRight, sign: '−', cls: 'out' },
  ingreso: { Icon: ArrowDownLeft, sign: '+', cls: 'in' },
  transferencia: { Icon: Swap, sign: '', cls: 'move' },
} as const;

export function Movimientos({ d }: { d: Dashboard }) {
  return (
    <Section icon={<List />} title="Últimos movimientos" className="span-2">
      {d.movimientos.length === 0 ? (
        <Empty icon={<List size={28} />} text="Registra tu primer movimiento en el chat." />
      ) : (
        <ul className="moves">
          {d.movimientos.map((m, i) => {
            const t = TIPO[m.tipo];
            return (
              <li key={`${m.fecha}-${i}`}>
                <span className="move-emoji" aria-hidden="true">
                  {m.emoji}
                </span>
                <span className="move-main">
                  <span className="move-desc">{m.descripcion || capitalizar(m.categoria)}</span>
                  <span className="move-sub">
                    <t.Icon size={12} /> {capitalizar(m.categoria)} · {fecha(m.fecha)}
                  </span>
                </span>
                <b className={`move-amt ${t.cls}`}>
                  {t.sign}
                  {q(m.monto)}
                </b>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="empty">
      {icon}
      <p>{text}</p>
    </div>
  );
}
