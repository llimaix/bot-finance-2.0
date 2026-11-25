/**
 * Datos del dashboard de la Mini App. `buildDashboard` es PURO; `loadDashboard`
 * solo lee (Query/GetItem): el chat sigue siendo el único canal de escritura.
 */
import type { BudgetProgress } from '../budgets';
import { addDaysTo, daysInMonth, monthPrefixGT } from '../dates';
import { queryItemsByPrefix } from '../dynamo';
import { emojiFor, emojiForCategory } from '../format';
import { loadAdvisorData } from '../insights';
import { currentUserName, loadProfile } from '../profile';
import type { Transaction } from '../types';
import type { Libre } from '../v2/libre';
import { esLiquida, esPrestamo } from '../v2/model';
import { toCents } from '../v2/money';
import type { SaldoV2 } from '../v2/saldos';
import { loadBalancesV2 } from '../v2/saldos';
import type { FotoDiaria } from '../v2/snapshot';
import { loadLibre } from '../v2/snapshot';
import type { TarjetaConCiclo } from '../v2/tarjetas';
import { loadCiclos } from '../v2/tarjetas';
import type { Dashboard } from './contract';

const MAX_CATEGORIAS = 7;
const MAX_MOVIMIENTOS = 12;
const MAX_HISTORIAL = 90;

export interface DashboardInput {
  hoy: string;
  generadoEn: string;
  usuario: string | null;
  saldos: ReadonlyArray<SaldoV2>;
  tarjetas: ReadonlyArray<TarjetaConCiclo>;
  libre: Libre;
  monthTxns: ReadonlyArray<Transaction>;
  prevTxns: ReadonlyArray<Transaction>;
  metas: ReadonlyArray<BudgetProgress>;
  fotos: ReadonlyArray<FotoDiaria>;
}

const dias = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Monto en centavos: el campo v2 si existe; si no, el legado en quetzales. */
const centavos = (t: Transaction): number => t.v2?.montoCentavos ?? toCents(t.amount);
const esGasto = (t: Transaction): boolean => (t.v2?.tipo ?? t.type) === 'gasto';
/** v1 también tiene depósito y retiro (entre cuentas): para el dashboard son transferencias. */
const tipoMovimiento = (t: Transaction): Dashboard['movimientos'][number]['tipo'] => {
  const tipo = t.v2?.tipo ?? t.type;
  return tipo === 'gasto' || tipo === 'ingreso' ? tipo : 'transferencia';
};

export function buildDashboard(input: DashboardInput): Dashboard {
  const { hoy } = input;
  const mes = hoy.slice(0, 7);
  const diaHoy = Number(hoy.slice(8, 10));
  const enDias = daysInMonth(mes);

  const activas = input.saldos.filter((s) => s.cuenta.activa);
  const cuentas = activas
    .filter((s) => esLiquida(s.cuenta))
    .map((s) => ({
      id: s.cuenta.id,
      nombre: s.cuenta.nombre,
      tipo: s.cuenta.tipo as Dashboard['cuentas'][number]['tipo'],
      saldo: s.saldoCentavos,
      terminaciones: s.cuenta.terminaciones,
    }))
    .sort((a, b) => b.saldo - a.saldo);

  const tarjetas = input.tarjetas.map(({ cuenta, ciclo }) => {
    const limite = cuenta.credito?.limiteCentavos ?? 0;
    return {
      id: cuenta.id,
      nombre: cuenta.nombre,
      terminaciones: cuenta.terminaciones,
      limite,
      deudaActual: ciclo.deudaActual,
      usoPct: limite > 0 ? Math.round((ciclo.deudaActual / limite) * 100) : 0,
      pendiente: ciclo.pendiente,
      fechaPago: ciclo.fechaPago,
      proximoCorte: ciclo.proximoCorte,
      consumoPeriodo: ciclo.consumoPeriodo,
      interesEstimado: ciclo.interesEstimado,
    };
  });

  // Gasto del mes: por categoría (top N + "otros") y por día.
  const gastos = input.monthTxns.filter((t) => esGasto(t) && t.date.startsWith(mes));
  const total = gastos.reduce((a, t) => a + centavos(t), 0);
  const porCat = new Map<string, number>();
  for (const t of gastos) porCat.set(t.category, (porCat.get(t.category) ?? 0) + centavos(t));
  const ordenadas = [...porCat.entries()].sort((a, b) => b[1] - a[1]);
  const porCategoria = ordenadas.slice(0, MAX_CATEGORIAS).map(([categoria, monto]) => ({
    categoria,
    emoji: emojiForCategory(categoria, gastos),
    monto,
  }));
  const resto = ordenadas.slice(MAX_CATEGORIAS).reduce((a, [, m]) => a + m, 0);
  if (resto > 0) porCategoria.push({ categoria: 'otros', emoji: '📦', monto: resto });

  const porDia = Array.from({ length: diaHoy }, (_, i) => {
    const fecha = `${mes}-${String(i + 1).padStart(2, '0')}`;
    return { fecha, monto: gastos.filter((t) => t.date === fecha).reduce((a, t) => a + centavos(t), 0) };
  });

  // Mes anterior hasta el mismo día: comparación justa a mitad de mes.
  const mesAnterior = monthPrefixGT(-1, new Date(`${hoy}T12:00:00Z`));
  const corteAnterior = `${mesAnterior}-${String(Math.min(diaHoy, daysInMonth(mesAnterior))).padStart(2, '0')}`;
  const totalMesAnteriorMismoDia = input.prevTxns
    .filter((t) => esGasto(t) && t.date.startsWith(mesAnterior) && t.date <= corteAnterior)
    .reduce((a, t) => a + centavos(t), 0);

  const l = input.libre;
  return {
    generadoEn: input.generadoEn,
    hoy,
    usuario: input.usuario,
    resumen: {
      disponible: l.disponible,
      deuda: l.deuda,
      prestamos: l.prestamos,
      neto: l.disponible - l.deuda - l.prestamos,
      libre: l.libreHastaIngreso,
      libreDespues: l.despues?.libre ?? null,
      proximoIngreso: l.ingreso
        ? { descripcion: l.ingreso.descripcion, fecha: l.ingreso.fecha, monto: l.ingreso.montoCentavos, dias: dias(hoy, l.ingreso.fecha) }
        : null,
    },
    cuentas,
    tarjetas,
    prestamos: activas
      .filter((s) => esPrestamo(s.cuenta))
      .map((s) => ({
        id: s.cuenta.id,
        nombre: s.cuenta.nombre,
        deuda: Math.max(0, -s.saldoCentavos),
        cuota: s.cuenta.prestamo?.cuotaCentavos ?? null,
        diaPago: s.cuenta.prestamo?.diaPago ?? null,
        vence: s.cuenta.prestamo?.vence ?? null,
      })),
    gastoMes: {
      mes,
      total,
      totalMesAnteriorMismoDia,
      proyeccion: diaHoy > 0 ? Math.round((total / diaHoy) * enDias) : total,
      porCategoria,
      porDia,
    },
    metas: input.metas.map((m) => ({
      categoria: m.category,
      emoji: emojiForCategory(m.category, gastos),
      limite: toCents(m.monthlyLimit),
      gastado: toCents(m.spent),
      pct: Math.round(m.pct),
      estado: m.status,
    })),
    historial: [...input.fotos]
      .sort((a, b) => a.fecha.localeCompare(b.fecha))
      .slice(-MAX_HISTORIAL)
      .map((f) => ({ fecha: f.fecha, disponible: f.disponibleCentavos, deuda: f.deudaCentavos, libre: f.libreCentavos })),
    movimientos: [...input.monthTxns]
      .sort((a, b) => b.date.localeCompare(a.date) || b.sk.localeCompare(a.sk))
      .slice(0, MAX_MOVIMIENTOS)
      .map((t) => ({
        fecha: t.date,
        descripcion: t.description,
        categoria: t.category,
        emoji: emojiFor(t),
        monto: centavos(t),
        tipo: tipoMovimiento(t),
      })),
  };
}

function esFoto(raw: Record<string, unknown>): raw is Record<string, unknown> & FotoDiaria {
  return typeof raw.fecha === 'string' && typeof raw.disponibleCentavos === 'number' && typeof raw.deudaCentavos === 'number';
}

export async function loadDashboard(hoy: string, now: Date = new Date()): Promise<Dashboard> {
  const advisor = await loadAdvisorData(hoy, daysInMonth(monthPrefixGT(0, now)));
  const [{ saldos }, { tarjetas }, { libre }, fotos] = await Promise.all([
    loadBalancesV2(hoy),
    loadCiclos(hoy),
    loadLibre(hoy, advisor),
    queryItemsByPrefix('SNAP#'),
    loadProfile(),
  ]);
  return buildDashboard({
    hoy,
    generadoEn: now.toISOString(),
    usuario: currentUserName(),
    saldos,
    tarjetas,
    libre,
    monthTxns: advisor.monthTxns,
    prevTxns: advisor.prevTxns,
    metas: advisor.metas,
    fotos: fotos.filter(esFoto).filter((f) => f.fecha >= addDaysTo(hoy, -MAX_HISTORIAL)),
  });
}
