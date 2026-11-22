/**
 * Ciclo de cada tarjeta de crédito (diseño, sección 5). PURO.
 *
 * - Corte: diaCorte de cada mes; si el mes es más corto (31 en febrero), el
 *   último día del mes.
 * - Pago: diaPago del mismo mes si es posterior al corte; si no, del mes
 *   siguiente. Se ajusta a día hábil (lunes a viernes; sin feriados).
 * - Deuda al corte: saldo con los movimientos hasta el corte inclusive.
 * - Pagado: movimientos con destino = tarjeta después del corte y hasta el pago.
 * - Pendiente: deuda al corte − pagado (nunca negativo).
 * - Interés estimado: pendiente × tasa mensual (anual / 12). Es una estimación:
 *   cada banco calcula a su manera y el cargo real del estado de cuenta manda.
 */
import { saldoCentavos } from './balance';
import type { Cuenta, Movimiento } from './model';

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const parse = (s: string): Date => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number): string => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

function diaDelMes(year: number, month0: number, dia: number): string {
  const ultimo = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(year, month0, Math.min(dia, ultimo))));
}

export function ajustarHabil(fecha: string, modo: 'siguiente_habil' | 'anterior_habil' | 'ninguno'): string {
  if (modo === 'ninguno') return fecha;
  let f = fecha;
  const paso = modo === 'siguiente_habil' ? 1 : -1;
  for (let wd = parse(f).getUTCDay(); wd === 0 || wd === 6; wd = parse(f).getUTCDay()) f = addDays(f, paso);
  return f;
}

/** Fecha de corte del mes de `fecha` (yyyy-mm-dd). */
export function corteDelMes(diaCorte: number, fecha: string): string {
  const d = parse(fecha);
  return diaDelMes(d.getUTCFullYear(), d.getUTCMonth(), diaCorte);
}

/** Último corte en o antes de `hoy` y el siguiente. */
export function cortes(diaCorte: number, hoy: string): { ultimo: string; proximo: string } {
  const d = parse(hoy);
  const esteMes = diaDelMes(d.getUTCFullYear(), d.getUTCMonth(), diaCorte);
  if (esteMes <= hoy) {
    return { ultimo: esteMes, proximo: diaDelMes(d.getUTCFullYear(), d.getUTCMonth() + 1, diaCorte) };
  }
  return { ultimo: diaDelMes(d.getUTCFullYear(), d.getUTCMonth() - 1, diaCorte), proximo: esteMes };
}

/** Fecha de pago que corresponde a un corte, ya ajustada a día hábil. */
export function fechaPago(credito: NonNullable<Cuenta['credito']>, corte: string): string {
  const d = parse(corte);
  const mismoMes = credito.diaPago > credito.diaCorte;
  const bruta = diaDelMes(d.getUTCFullYear(), d.getUTCMonth() + (mismoMes ? 0 : 1), credito.diaPago);
  return ajustarHabil(bruta, credito.ajustePago);
}

export interface CicloTarjeta {
  cuentaId: string;
  ultimoCorte: string;
  proximoCorte: string;
  fechaPago: string;
  deudaAlCorte: number;
  pagado: number;
  pendiente: number;
  /** Compras desde el último corte (entran en el próximo). */
  consumoPeriodo: number;
  deudaActual: number;
  /** null si la tarjeta no tiene tasa configurada. */
  interesEstimado: number | null;
  /** La semilla es posterior al corte: la deuda al corte es aproximada. */
  aproximado: boolean;
}

export function interesEstimado(pendiente: number, interes: { tasaBps: number; periodo: 'mensual' | 'anual' }): number {
  const mensualBps = interes.periodo === 'anual' ? interes.tasaBps / 12 : interes.tasaBps;
  return Math.round((pendiente * mensualBps) / 10_000);
}

export function cicloTarjeta(cuenta: Cuenta, movs: ReadonlyArray<Movimiento>, hoy: string): CicloTarjeta | null {
  if (cuenta.tipo !== 'credito' || !cuenta.credito) return null;
  const { ultimo, proximo } = cortes(cuenta.credito.diaCorte, hoy);
  const pago = fechaPago(cuenta.credito, ultimo);

  const deudaAlCorte = Math.max(0, -saldoCentavos(cuenta, movs.filter((m) => m.fecha <= ultimo)));
  const despuesDelCorte = movs.filter((m) => m.fecha > ultimo);
  const pagado = despuesDelCorte
    .filter((m) => m.destino === cuenta.id && m.fecha <= pago)
    .reduce((a, m) => a + m.montoCentavos, 0);
  const consumoPeriodo = despuesDelCorte.filter((m) => m.origen === cuenta.id).reduce((a, m) => a + m.montoCentavos, 0);
  const pendiente = Math.max(0, deudaAlCorte - pagado);

  return {
    cuentaId: cuenta.id,
    ultimoCorte: ultimo,
    proximoCorte: proximo,
    fechaPago: pago,
    deudaAlCorte,
    pagado,
    pendiente,
    consumoPeriodo,
    deudaActual: Math.max(0, -saldoCentavos(cuenta, movs)),
    interesEstimado: cuenta.credito.interes ? interesEstimado(pendiente, cuenta.credito.interes) : null,
    aproximado: cuenta.asOf > ultimo,
  };
}
