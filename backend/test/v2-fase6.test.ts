import { describe, expect, it } from 'vitest';
import { budgetCrossings } from '../src/lib/budgets';
import type { Libre } from '../src/lib/v2/libre';
import { fotoDiaria, gastoDiarioCentavos, snapSk } from '../src/lib/v2/snapshot';
import type { BudgetRecord, Transaction } from '../src/lib/types';

const meta: BudgetRecord = { category: 'comida', monthlyLimit: 1000, source: 'user', createdAt: '', updatedAt: '' };

const gasto = (amount: number, over: Partial<Transaction> = {}): Transaction =>
  ({ type: 'gasto', category: 'comida', amount, date: '2026-11-22', ...over }) as Transaction;

describe('avisos de meta al registrar', () => {
  it('avisa al cruzar el 80 %', () => {
    const previos = [gasto(700)];
    const nuevo = [gasto(150)];
    expect(budgetCrossings([meta], [...previos, ...nuevo], nuevo, '2026-11')).toEqual([
      '🟡 Llevas el 85% de tu meta de comida: Q850.00 de Q1,000.00.',
    ]);
  });

  it('avisa al pasar el 100 % (aunque salte desde abajo del 80 %)', () => {
    const nuevo = [gasto(1200)];
    expect(budgetCrossings([meta], nuevo, nuevo, '2026-11')[0]).toContain('🔴 Pasaste tu meta de comida');
  });

  it('no repite si ya estaba por encima del umbral', () => {
    const nuevo = [gasto(50)];
    expect(budgetCrossings([meta], [gasto(850), ...nuevo], nuevo, '2026-11')).toEqual([]);
  });

  it('ignora otras categorías, ingresos y movimientos de otro mes', () => {
    const otros = [gasto(900, { category: 'transporte' }), gasto(900, { type: 'ingreso' }), gasto(900, { date: '2026-10-30' })];
    expect(budgetCrossings([meta], otros, otros, '2026-11')).toEqual([]);
  });
});

describe('foto diaria SNAP#', () => {
  const libre: Libre = {
    disponible: 520_000,
    deuda: 250_000,
    ingreso: { descripcion: 'Salario', fecha: '2026-11-30', montoCentavos: 800_000 },
    dias: 8,
    tarjetas: [],
    recurrentes: [{ concepto: 'Netflix', fecha: '2026-11-25', montoCentavos: 8_000 }],
    gastoVariable: 80_000,
    libreHastaIngreso: 432_000,
    despues: { hasta: '2026-12-15', libre: 1_002_000 },
  };

  it('guarda solo cifras agregadas, sin conceptos', () => {
    const foto = fotoDiaria('2026-11-22', libre);
    expect(foto).toEqual({
      fecha: '2026-11-22',
      disponibleCentavos: 520_000,
      deudaCentavos: 250_000,
      libreCentavos: 432_000,
      libreDespuesCentavos: 1_002_000,
      proximoIngreso: '2026-11-30',
    });
    expect(JSON.stringify(foto)).not.toContain('Netflix');
    expect(snapSk('2026-11-22')).toBe('SNAP#2026-11-22');
  });

  it('sin ingresos declarados el libre queda en null', () => {
    const foto = fotoDiaria('2026-11-22', { ...libre, ingreso: null, libreHastaIngreso: null, despues: null });
    expect(foto).toMatchObject({ libreCentavos: null, libreDespuesCentavos: null, proximoIngreso: null });
  });

  it('gasto diario: promedio de los gastos v2 del mes', () => {
    const t = (tipo: 'gasto' | 'ingreso', montoCentavos: number) => ({ v2: { tipo, montoCentavos } }) as Transaction;
    expect(gastoDiarioCentavos({ monthTxns: [t('gasto', 30_000), t('ingreso', 900_000), t('gasto', 10_000)], daysElapsed: 4 })).toBe(10_000);
    expect(gastoDiarioCentavos({ monthTxns: [], daysElapsed: 0 })).toBe(0);
  });
});
