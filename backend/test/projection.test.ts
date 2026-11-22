import { describe, expect, it } from 'vitest';
import { computeProjection } from '../src/lib/projection';
import type { AdvisorRecurring } from '../src/lib/recurring';
import type { Transaction } from '../src/lib/types';

const rec = (partial: Partial<AdvisorRecurring>): AdvisorRecurring => ({
  descripcion: 'x',
  categoria: 'servicios',
  tipo: 'gasto',
  montoTipico: 100,
  diaTipicoDePago: 20,
  estado: 'confirmado',
  yaPagadoEsteMes: false,
  aunVieneEsteMes: true,
  ...partial,
});

let n = 0;
const gasto = (amount: number, category = 'comida', description = `var ${++n}`): Transaction => ({
  sk: `TXN#2026-07-05#p${n}`,
  date: '2026-07-05',
  shortId: n,
  amount,
  type: 'gasto',
  category,
  method: 'efectivo',
  description,
  rawMessage: '',
  createdAt: '',
});

describe('computeProjection', () => {
  it('neto + ingresos confirmados − compromisos − variable proyectado', () => {
    const p = computeProjection({
      netoLiquido: 1000,
      recurrentes: [
        rec({ tipo: 'ingreso', montoTipico: 7500, estado: 'confirmado' }), // entra
        rec({ tipo: 'ingreso', montoTipico: 999, estado: 'posible' }), // conservador: NO cuenta
        rec({ tipo: 'gasto', montoTipico: 1840, estado: 'confirmado' }), // compromete
        rec({ tipo: 'gasto', montoTipico: 300, estado: 'posible' }), // compromete igual
        rec({ tipo: 'gasto', montoTipico: 500, aunVieneEsteMes: false }), // ya pagado: no
      ],
      monthTxns: [gasto(100), gasto(200)], // variable 300 en 10 días → 30/día
      daysElapsed: 10,
      daysInMonth: 31,
    });

    expect(p.diasRestantes).toBe(21);
    expect(p.ingresosEsperadosRestantes).toBe(7500);
    expect(p.compromisosPendientes).toBe(2140);
    expect(p.gastoVariableDiario).toBe(30);
    expect(p.gastoVariableProyectado).toBe(630);
    // 1000 + 7500 − 2140 − 630
    expect(p.disponibleProyectadoFinDeMes).toBe(5730);
  });

  it('excluye del gasto variable lo que pertenece a recurrentes', () => {
    const p = computeProjection({
      netoLiquido: 0,
      recurrentes: [rec({ descripcion: 'Netflix', categoria: 'suscripciones', aunVieneEsteMes: false })],
      monthTxns: [gasto(108.7, 'suscripciones', 'Netflix'), gasto(50)],
      daysElapsed: 10,
      daysInMonth: 30,
    });
    expect(p.gastoVariableDiario).toBe(5); // solo los Q50 variables
  });

  it('fin de mes: sin días restantes no proyecta variable', () => {
    const p = computeProjection({
      netoLiquido: 500,
      recurrentes: [],
      monthTxns: [gasto(900)],
      daysElapsed: 31,
      daysInMonth: 31,
    });
    expect(p.diasRestantes).toBe(0);
    expect(p.gastoVariableProyectado).toBe(0);
    expect(p.disponibleProyectadoFinDeMes).toBe(500);
  });
});
