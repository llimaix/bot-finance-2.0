import { DEFAULT_ACCOUNTS, computeBalances } from './accounts';
import type { AccountBalance } from './accounts';
import { computeAggregates } from './aggregates';
import { budgetProgress } from './budgets';
import type { BudgetProgress } from './budgets';
import { daysAgoGT, daysElapsedInMonthGT, monthPrefixGT, nextPaydayAfter, paydaysOfMonth } from './dates';
import { listAccounts, listBudgets, listRecurring, queryMonth, queryRange } from './dynamo';
import { escapeHtml, formatQ } from './format';
import { computeProjection } from './projection';
import type { Projection } from './projection';
import { applySalaryCalendar, detectRecurring, recurringForAdvisor } from './recurring';
import type { AdvisorRecurring } from './recurring';
import type { Account, Transaction } from './types';

/**
 * Ensamble de datos para asesorar (webhook) y vigilar (guardián). Solo LECTURAS:
 * si las cuentas no existen aún, se asumen en cero (estimadas) sin escribir.
 */

export async function loadBalancesReadonly(today: string): Promise<AccountBalance[]> {
  const stored = await listAccounts();
  const accounts: Account[] =
    stored.length > 0
      ? stored
      : DEFAULT_ACCOUNTS.map((d) => ({ ...d, seedBalance: 0, asOf: today, estimated: true, updatedAt: '' }));
  const minAsOf = accounts.reduce((min, a) => (a.asOf < min ? a.asOf : min), today);
  const txns = await queryRange(minAsOf, today);
  return computeBalances(accounts, txns);
}

export interface AdvisorData {
  today: string;
  balances: AccountBalance[];
  netoLiquido: number;
  recurrentes: AdvisorRecurring[];
  proyeccion: Projection;
  monthTxns: Transaction[];
  prevTxns: Transaction[];
  weekTxns: Transaction[];
  daysElapsed: number;
  daysInMonth: number;
  /** Progreso del mes contra las metas de gasto (vacío si no hay metas). */
  metas: BudgetProgress[];
}

export async function loadAdvisorData(today: string, daysInCurrentMonth: number): Promise<AdvisorData> {
  const [balances, monthTxns, prevTxns, prev2Txns, weekTxns, knownRecurring, budgets] = await Promise.all([
    loadBalancesReadonly(today),
    queryMonth(monthPrefixGT(0)),
    queryMonth(monthPrefixGT(-1)),
    queryMonth(monthPrefixGT(-2)),
    queryRange(daysAgoGT(6), today),
    listRecurring(),
    listBudgets(),
  ]);

  const netoLiquido = Math.round(balances.reduce((acc, b) => acc + b.balance, 0) * 100) / 100;
  const daysElapsed = daysElapsedInMonthGT();

  const detected = detectRecurring([...prev2Txns, ...prevTxns, ...monthTxns], {
    types: ['gasto', 'ingreso'],
  });
  // Los salarios usan el calendario real (15 y fin de mes, ajustado a día
  // hábil), no el día mediano observado — de esto depende la proyección.
  const [q1, q2] = paydaysOfMonth(monthPrefixGT(0));
  const recurrentes = applySalaryCalendar(
    recurringForAdvisor(detected, knownRecurring, monthTxns, daysElapsed),
    [Number(q1.slice(8)), Number(q2.slice(8))],
    daysElapsed,
  );

  const proyeccion = computeProjection({
    netoLiquido,
    recurrentes,
    monthTxns,
    daysElapsed,
    daysInMonth: daysInCurrentMonth,
  });

  const metas = budgetProgress(budgets, monthTxns, daysElapsed, daysInCurrentMonth);

  return {
    today,
    balances,
    netoLiquido,
    recurrentes,
    proyeccion,
    monthTxns,
    prevTxns,
    weekTxns,
    daysElapsed,
    daysInMonth: daysInCurrentMonth,
    metas,
  };
}

/** Mensaje del comando /proyeccion. */
export function renderProjection(data: AdvisorData): string {
  const p = data.proyeccion;
  const lines = [
    '🔭 <b>Proyección a fin de mes</b>',
    '',
    `Neto líquido hoy: ${formatQ(data.netoLiquido)}`,
    `+ Ingresos confirmados que faltan: ${formatQ(p.ingresosEsperadosRestantes)}`,
    `− Compromisos recurrentes pendientes: ${formatQ(p.compromisosPendientes)}`,
    `− Gasto variable proyectado (${formatQ(p.gastoVariableDiario)}/día × ${p.diasRestantes} días): ${formatQ(p.gastoVariableProyectado)}`,
    '',
    `= <b>Disponible proyectado: ${formatQ(p.disponibleProyectadoFinDeMes)}</b>`,
  ];

  const pendientes = data.recurrentes.filter((r) => r.tipo === 'gasto' && r.aunVieneEsteMes);
  if (pendientes.length > 0) {
    lines.push('', '<b>Lo que aún viene este mes:</b>');
    for (const r of pendientes.slice(0, 8)) {
      lines.push(`• ${escapeHtml(r.descripcion)} — ~${formatQ(r.montoTipico)} (día ~${r.diaTipicoDePago})`);
    }
  }
  if (p.disponibleProyectadoFinDeMes < 0) {
    lines.push('', '⚠️ La proyección es negativa: con el ritmo actual no cierras el mes.');
  }
  lines.push('', '💡 Confirma tus recurrentes (incluidos ingresos) con /recurrentes para afinar esta proyección.');
  return lines.join('\n');
}

// ── Insumos del coach (todos los números nacen aquí; el LLM solo redacta) ──

function summarizeForCoach(txns: ReadonlyArray<Transaction>, days: number) {
  const agg = computeAggregates([...txns], days);
  return {
    totalGastos: agg.totalGastos,
    totalIngresos: agg.totalIngresos,
    promedioDiarioGasto: agg.dailyAverage,
    porCategoria: Object.entries(agg.byCategory)
      .sort(([, a], [, b]) => b.sum - a.sum)
      .slice(0, 6)
      .map(([categoria, d]) => ({ categoria, total: d.sum, movimientos: d.count })),
    gastosHormiga: agg.hormiga,
  };
}

function metasForCoach(metas: ReadonlyArray<BudgetProgress>) {
  return metas.map((m) => ({
    categoria: m.category,
    topeMensual: m.monthlyLimit,
    gastadoEsteMes: m.spent,
    porcentaje: m.pct,
    ritmoProyectado: m.paceProjected,
    estado: m.status,
  }));
}

/** Insumo del coach semanal (domingo). */
export function weeklyCoachInput(data: AdvisorData, prevWeekTxns: ReadonlyArray<Transaction>) {
  return {
    fecha: data.today,
    semana: summarizeForCoach(data.weekTxns, 7),
    semanaAnterior: prevWeekTxns.length > 0 ? summarizeForCoach(prevWeekTxns, 7) : null,
    mesEnCurso: {
      diasTranscurridos: data.daysElapsed,
      ...summarizeForCoach(data.monthTxns, data.daysElapsed),
    },
    mesAnterior: data.prevTxns.length > 0 ? summarizeForCoach(data.prevTxns, 30) : null,
    netoLiquido: data.netoLiquido,
    proyeccionFinDeMes: data.proyeccion,
    metas: metasForCoach(data.metas),
    recurrentesQueAunVienen: data.recurrentes
      .filter((r) => r.aunVieneEsteMes)
      .map((r) => ({ descripcion: r.descripcion, tipo: r.tipo, monto: r.montoTipico, diaTipico: r.diaTipicoDePago })),
  };
}

/** Insumo del checkpoint de quincena (día 14 y 28). Días de pago: 15 y 29. */
export function paydayCoachInput(data: AdvisorData) {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const pendientes = data.recurrentes.filter((r) => r.tipo === 'gasto' && r.aunVieneEsteMes);
  const ingresos = data.recurrentes.filter(
    (r) => r.tipo === 'ingreso' && r.estado === 'confirmado' && r.aunVieneEsteMes,
  );
  // Colchón: el gasto variable típico hasta la próxima quincena (~14 días),
  // sin pasarse de los días que le quedan al mes.
  const diasColchon = Math.min(14, data.proyeccion.diasRestantes);
  const colchonVariable = round2(data.proyeccion.gastoVariableDiario * diasColchon);
  const totalCompromisos = round2(pendientes.reduce((acc, r) => acc + r.montoTipico, 0));

  return {
    fecha: data.today,
    // Fecha REAL del próximo pago (15 o fin de mes, ajustado a día hábil).
    fechaDePago: nextPaydayAfter(data.today),
    ingresoQueViene: ingresos.map((r) => ({ descripcion: r.descripcion, monto: r.montoTipico, diaTipico: r.diaTipicoDePago })),
    compromisosPendientes: {
      total: totalCompromisos,
      detalle: pendientes.map((r) => ({ descripcion: r.descripcion, monto: r.montoTipico, diaTipico: r.diaTipicoDePago })),
    },
    colchonGastoVariable: { dias: diasColchon, porDia: data.proyeccion.gastoVariableDiario, total: colchonVariable },
    sugerenciaApartarAlCaer: round2(totalCompromisos + colchonVariable),
    saldos: data.balances.map((b) => ({ cuenta: b.name, saldo: b.balance, estimado: b.estimated })),
    netoLiquido: data.netoLiquido,
    proyeccionFinDeMes: data.proyeccion,
    metas: metasForCoach(data.metas),
  };
}

/**
 * Hallazgos del guardián diario. Reglas deterministas; si no hay nada que
 * decir devuelve lista vacía (y el guardián guarda silencio).
 */
export function guardianFindings(data: AdvisorData): string[] {
  const findings: string[] = [];

  for (const b of data.balances) {
    if ((b.id === 'efectivo' || b.id === 'kash') && b.balance < 0) {
      findings.push(
        `${b.emoji} Tu ${b.name} calculado quedó en ${formatQ(b.balance)}: probablemente hubo un ingreso de dinero que no registraste. Ajusta con /saldo ${b.id} <monto>.`,
      );
    }
  }

  const GRACE_DAYS = 3;
  const vencidos = data.recurrentes.filter(
    (r) =>
      r.tipo === 'gasto' &&
      r.estado === 'confirmado' &&
      !r.yaPagadoEsteMes &&
      r.diaTipicoDePago + GRACE_DAYS < data.daysElapsed,
  );
  for (const r of vencidos.slice(0, 4)) {
    findings.push(
      `🔔 No veo el pago de <b>${escapeHtml(r.descripcion)}</b> este mes (~${formatQ(r.montoTipico)}, suele caer el día ${r.diaTipicoDePago}). ¿Ya lo pagaste?`,
    );
  }

  if (data.proyeccion.disponibleProyectadoFinDeMes < 0) {
    findings.push(
      `⚠️ Proyección en rojo: al ritmo actual cerrarías el mes en ${formatQ(data.proyeccion.disponibleProyectadoFinDeMes)}. Mira /proyeccion.`,
    );
  }

  // Meta reventada: avisar solo mientras el exceso está activo (hubo gasto en
  // esa categoría ayer u hoy), no todas las mañanas hasta fin de mes.
  const yesterday = new Date(Date.parse(data.today) - 86_400_000).toISOString().slice(0, 10);
  for (const m of data.metas) {
    const activo = data.monthTxns.some(
      (t) => t.type === 'gasto' && t.category === m.category && t.date >= yesterday,
    );
    if (m.status === 'rojo' && activo) {
      findings.push(
        `🎯 Reventaste tu meta de <b>${escapeHtml(m.category)}</b>: llevas ${formatQ(m.spent)} de ${formatQ(m.monthlyLimit)}. Frenar ahí el resto del mes ayuda a tu proyección.`,
      );
    }
  }

  return findings;
}
