import { txnRecurringKey } from './recurring';
import type { AdvisorRecurring } from './recurring';
import type { Transaction } from './types';

export interface ProjectionInput {
  netoLiquido: number;
  /** Recurrentes del asesor (gastos e ingresos, confirmados y posibles). */
  recurrentes: ReadonlyArray<AdvisorRecurring>;
  /** Movimientos del mes en curso. */
  monthTxns: ReadonlyArray<Transaction>;
  daysElapsed: number;
  daysInMonth: number;
}

export interface Projection {
  diasRestantes: number;
  /** Solo ingresos CONFIRMADOS que aún vienen (conservador con la plata que entra). */
  ingresosEsperadosRestantes: number;
  /** Gastos recurrentes confirmados Y posibles que aún vienen (conservador con la que sale). */
  compromisosPendientes: number;
  /** Gasto diario del mes excluyendo recurrentes (lo hormiga + variable). */
  gastoVariableDiario: number;
  gastoVariableProyectado: number;
  disponibleProyectadoFinDeMes: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Proyección determinista a fin de mes. Filosofía conservadora: los ingresos
 * futuros solo cuentan si están confirmados; los compromisos cuentan aunque
 * sean "posibles". El LLM narra sobre esto, nunca lo calcula.
 */
export function computeProjection(input: ProjectionInput): Projection {
  const diasRestantes = Math.max(0, input.daysInMonth - input.daysElapsed);

  const ingresosEsperadosRestantes = round2(
    input.recurrentes
      .filter((r) => r.tipo === 'ingreso' && r.estado === 'confirmado' && r.aunVieneEsteMes)
      .reduce((acc, r) => acc + r.montoTipico, 0),
  );

  const compromisosPendientes = round2(
    input.recurrentes
      .filter((r) => r.tipo === 'gasto' && r.aunVieneEsteMes)
      .reduce((acc, r) => acc + r.montoTipico, 0),
  );

  // Gasto variable: lo gastado este mes que NO pertenece a un concepto recurrente.
  const recurringKeys = new Set(
    input.recurrentes
      .filter((r) => r.tipo === 'gasto')
      .map((r) => txnRecurringKey({ type: 'gasto', category: r.categoria, description: r.descripcion })),
  );
  const variableSpent = round2(
    input.monthTxns
      .filter((t) => t.type === 'gasto' && !recurringKeys.has(txnRecurringKey(t)))
      .reduce((acc, t) => acc + t.amount, 0),
  );
  const gastoVariableDiario = input.daysElapsed > 0 ? round2(variableSpent / input.daysElapsed) : 0;
  const gastoVariableProyectado = round2(gastoVariableDiario * diasRestantes);

  const disponibleProyectadoFinDeMes = round2(
    input.netoLiquido + ingresosEsperadosRestantes - compromisosPendientes - gastoVariableProyectado,
  );

  return {
    diasRestantes,
    ingresosEsperadosRestantes,
    compromisosPendientes,
    gastoVariableDiario,
    gastoVariableProyectado,
    disponibleProyectadoFinDeMes,
  };
}
