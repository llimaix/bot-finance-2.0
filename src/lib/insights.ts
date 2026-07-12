import { DEFAULT_ACCOUNTS, computeBalances } from './accounts';
import type { AccountBalance } from './accounts';
import { daysAgoGT, daysElapsedInMonthGT, monthPrefixGT } from './dates';
import { listAccounts, listRecurring, queryMonth, queryRange } from './dynamo';
import { escapeHtml, formatQ } from './format';
import { computeProjection } from './projection';
import type { Projection } from './projection';
import { detectRecurring, recurringForAdvisor } from './recurring';
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
}

export async function loadAdvisorData(today: string, daysInCurrentMonth: number): Promise<AdvisorData> {
  const [balances, monthTxns, prevTxns, prev2Txns, weekTxns, knownRecurring] = await Promise.all([
    loadBalancesReadonly(today),
    queryMonth(monthPrefixGT(0)),
    queryMonth(monthPrefixGT(-1)),
    queryMonth(monthPrefixGT(-2)),
    queryRange(daysAgoGT(6), today),
    listRecurring(),
  ]);

  const netoLiquido = Math.round(balances.reduce((acc, b) => acc + b.balance, 0) * 100) / 100;
  const daysElapsed = daysElapsedInMonthGT();

  const detected = detectRecurring([...prev2Txns, ...prevTxns, ...monthTxns], {
    types: ['gasto', 'ingreso'],
  });
  const recurrentes = recurringForAdvisor(detected, knownRecurring, monthTxns, daysElapsed);

  const proyeccion = computeProjection({
    netoLiquido,
    recurrentes,
    monthTxns,
    daysElapsed,
    daysInMonth: daysInCurrentMonth,
  });

  return { today, balances, netoLiquido, recurrentes, proyeccion, monthTxns, prevTxns, weekTxns, daysElapsed };
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

  return findings;
}
