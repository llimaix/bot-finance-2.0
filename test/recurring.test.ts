import { describe, expect, it } from 'vitest';
import { detectRecurring } from '../src/lib/recurring';
import type { Transaction } from '../src/lib/types';

let n = 0;
function txn(date: string, description: string, amount: number, partial: Partial<Transaction> = {}): Transaction {
  n += 1;
  return {
    sk: `TXN#${date}#r${n}`,
    date,
    shortId: n,
    amount,
    type: 'gasto',
    category: 'servicios',
    method: 'debito',
    description,
    rawMessage: '',
    createdAt: `${date}T12:00:00Z`,
    ...partial,
  };
}

describe('detectRecurring', () => {
  it('detecta conceptos que aparecen en 2+ meses, con promedio mensual', () => {
    const rec = detectRecurring([
      txn('2026-05-18', 'Netflix', 108.56, { category: 'suscripciones' }),
      txn('2026-06-16', 'Netflix', 108.7, { category: 'suscripciones' }),
      txn('2026-07-10', 'Netflix', 108.7, { category: 'suscripciones' }),
      txn('2026-05-08', 'Universidad Mariano Gálvez', 1840, { category: 'educacion', method: 'credito' }),
      txn('2026-06-06', 'Universidad Mariano Gálvez', 1840, { category: 'educacion', method: 'credito' }),
      txn('2026-06-26', 'Universidad Mariano Gálvez', 1840, { category: 'educacion', method: 'credito' }),
      txn('2026-06-20', 'KEMIK Guatemala', 1574, { category: 'tecnologia', method: 'credito' }), // 1 mes: no recurrente
    ]);

    const umg = rec.find((r) => r.descripcion.includes('Mariano'));
    const netflix = rec.find((r) => r.descripcion === 'Netflix');
    expect(umg).toBeDefined();
    // junio tuvo 2 pagos (3,680) y mayo 1 (1,840) → promedio mensual 2,760
    expect(umg!.montoTipico).toBe(2760);
    expect(umg!.meses).toBe(2);
    expect(netflix!.meses).toBe(3);
    expect(netflix!.montoTipico).toBeCloseTo(108.65, 1);
    expect(rec.find((r) => r.descripcion.includes('KEMIK'))).toBeUndefined();
  });

  it('normaliza tildes y mayúsculas al agrupar, e ignora no-gastos', () => {
    const rec = detectRecurring([
      txn('2026-05-15', 'Comisión Bimóvil', 15),
      txn('2026-06-01', 'comision bimovil', 15),
      txn('2026-05-15', 'Salario', 7500, { type: 'ingreso', method: 'na' }),
      txn('2026-06-15', 'Salario', 7500, { type: 'ingreso', method: 'na' }),
    ]);
    expect(rec).toHaveLength(1);
    expect(rec[0]!.montoTipico).toBe(15);
  });

  it('ordena por monto descendente', () => {
    const rec = detectRecurring([
      txn('2026-05-01', 'Chico', 10),
      txn('2026-06-01', 'Chico', 10),
      txn('2026-05-01', 'Grande', 1000),
      txn('2026-06-01', 'Grande', 1000),
    ]);
    expect(rec.map((r) => r.descripcion)).toEqual(['Grande', 'Chico']);
  });
});
