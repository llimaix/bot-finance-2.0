/**
 * Ingresos esperados (diseño, sección 6). PURO, salvo los tipos.
 *
 * Se declaran desde el primer día ("me pagan Q8,000 el 15 y el último a BI")
 * y sustituyen el calendario fijo del original. Un ingreso registrado hacia la
 * cuenta de destino, a ±3 días de la fecha esperada y con un monto dentro de
 * ±10 %, lo concilia.
 */
import { z } from 'zod';
import { escapeHtml } from '../format';
import { ajustarHabil } from './ciclos';
import type { ConfigSnapshot } from './config';
import { findCuenta, slugify } from './config';
import type { Movimiento } from './model';
import { formatCents, toCents } from './money';

export const ingresoSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  descripcion: z.string().min(1).max(60),
  montoCentavos: z.number().int().positive(),
  cuentaDestino: z.string().min(1),
  /** Días del mes; 31 = último día. */
  dias: z.array(z.number().int().min(1).max(31)).min(1),
  ajuste: z.enum(['anterior_habil', 'siguiente_habil', 'ninguno']),
  activo: z.boolean(),
});
export type IngresoEsperado = z.infer<typeof ingresoSchema>;

const MARGEN_DIAS = 3;
const MARGEN_MONTO = 0.1;

const parse = (s: string): number => Date.parse(`${s}T00:00:00Z`);
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Fechas esperadas de un ingreso en el mes `yyyy-mm`, ajustadas a día hábil. */
export function fechasDelMes(ingreso: IngresoEsperado, mes: string): string[] {
  const [y, m] = mes.split('-').map(Number) as [number, number];
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [...new Set(ingreso.dias.map((d) => ajustarHabil(iso(Date.UTC(y, m - 1, Math.min(d, ultimo))), ingreso.ajuste)))].sort();
}

const mesDe = (fecha: string, delta: number): string => {
  const d = new Date(parse(fecha));
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)).slice(0, 7);
};

/** Próximas fechas (desde hoy inclusive) de todos los ingresos activos, en orden. */
export function proximosIngresos(
  ingresos: ReadonlyArray<IngresoEsperado>,
  hoy: string,
  cuantos = 2,
): Array<{ ingreso: IngresoEsperado; fecha: string }> {
  const fechas = ingresos
    .filter((i) => i.activo)
    .flatMap((ingreso) => [0, 1, 2].flatMap((d) => fechasDelMes(ingreso, mesDe(hoy, d)).map((fecha) => ({ ingreso, fecha }))))
    .filter((x) => x.fecha >= hoy)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  return fechas.slice(0, cuantos);
}

/** ¿Hay un ingreso registrado que corresponda a esa fecha esperada? */
export function conciliado(ingreso: IngresoEsperado, fechaEsperada: string, movs: ReadonlyArray<Movimiento>): boolean {
  const esperado = parse(fechaEsperada);
  return movs.some(
    (m) =>
      m.tipo === 'ingreso' &&
      m.destino === ingreso.cuentaDestino &&
      Math.abs(parse(m.fecha) - esperado) <= MARGEN_DIAS * 86_400_000 &&
      Math.abs(m.montoCentavos - ingreso.montoCentavos) <= ingreso.montoCentavos * MARGEN_MONTO,
  );
}

// ── Configuración por el agente ────────────────────────────────────────────

export interface IngresoInput {
  descripcion: string;
  /** Monto neto en quetzales. */
  monto: number;
  /** Cuenta donde se deposita (id, nombre, alias o terminación). */
  cuenta: string;
  dias: number[];
  ajuste: IngresoEsperado['ajuste'] | null;
  activo: boolean | null;
}

export function planIngreso(
  input: IngresoInput,
  snap: ConfigSnapshot,
  ingresos: ReadonlyArray<IngresoEsperado>,
): { ok: true; antes: IngresoEsperado | null; despues: IngresoEsperado } | { ok: false; errors: string[] } {
  const cuenta = findCuenta(input.cuenta, snap.cuentas.filter((c) => c.activa));
  if (!cuenta) return { ok: false, errors: [`No encontré la cuenta "${input.cuenta}" para depositar el ingreso.`] };
  if (cuenta.tipo === 'credito') return { ok: false, errors: ['Un ingreso no se deposita en una tarjeta de crédito.'] };

  const slug = slugify(input.descripcion);
  const antes = ingresos.find((i) => i.slug === slug) ?? null;
  const parsed = ingresoSchema.safeParse({
    slug,
    descripcion: input.descripcion.trim(),
    montoCentavos: toCents(input.monto),
    cuentaDestino: cuenta.id,
    dias: [...new Set(input.dias)].sort((a, b) => a - b),
    ajuste: input.ajuste ?? antes?.ajuste ?? 'anterior_habil',
    activo: input.activo ?? true,
  });
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  return { ok: true, antes, despues: parsed.data };
}

export function resumenIngreso(i: IngresoEsperado, snap: ConfigSnapshot): string {
  const cuenta = snap.cuentas.find((c) => c.id === i.cuentaDestino)?.nombre ?? i.cuentaDestino;
  const dias = i.dias.map((d) => (d === 31 ? 'último día' : String(d))).join(' y ');
  const ajuste = i.ajuste === 'anterior_habil' ? ' (si cae en fin de semana, el hábil anterior)' : i.ajuste === 'siguiente_habil' ? ' (si cae en fin de semana, el hábil siguiente)' : '';
  return `💰 <b>${escapeHtml(i.descripcion)}</b>: ${formatCents(i.montoCentavos)} el ${dias}${ajuste} → ${escapeHtml(cuenta)}${i.activo ? '' : ' (inactivo)'}`;
}
