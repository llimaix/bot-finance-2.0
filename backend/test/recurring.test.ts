import { describe, expect, it } from 'vitest';
import { detectRecurring, findNewCandidates, recurringForAdvisor, recurringSlug } from '../src/lib/recurring';
import type { RecurringRecord, Transaction } from '../src/lib/types';

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

  it('detecta INGRESOS recurrentes normalizando nombres de mes (quincenas)', () => {
    const rec = detectRecurring(
      [
        txn('2026-05-15', 'Salario 1ra Quincena mayo 2026', 7500, { type: 'ingreso', category: 'otros', method: 'na' }),
        txn('2026-06-15', 'Salario 1ra Quincena Junio 2026', 7500, { type: 'ingreso', category: 'otros', method: 'na' }),
        txn('2026-05-29', 'Salario 2da Quincena mayo 2026', 6273.2, { type: 'ingreso', category: 'otros', method: 'na' }),
        txn('2026-06-25', 'Salario 2da Quincena junio 2026', 6294.8, { type: 'ingreso', category: 'otros', method: 'na' }),
      ],
      { types: ['gasto', 'ingreso'] },
    );
    expect(rec).toHaveLength(2); // 1ra y 2da quincena agrupan por separado
    expect(rec.every((r) => r.tipo === 'ingreso')).toBe(true);
    const primera = rec.find((r) => r.descripcion.includes('1ra'))!;
    expect(primera.montoTipico).toBe(7500);
    expect(primera.diaTipico).toBe(15);
  });

  it('ordena por monto descendente y calcula el día típico (mediana)', () => {
    const rec = detectRecurring([
      txn('2026-05-04', 'Chico', 10),
      txn('2026-06-06', 'Chico', 10),
      txn('2026-05-08', 'Grande', 1000),
      txn('2026-06-06', 'Grande', 1000),
      txn('2026-07-07', 'Grande', 1000),
    ]);
    expect(rec.map((r) => r.descripcion)).toEqual(['Grande', 'Chico']);
    expect(rec[0]!.diaTipico).toBe(7); // mediana de 8, 6, 7
    expect(rec[1]!.diaTipico).toBe(4); // mediana de 4, 6 → el menor de los centrales
  });
});

const record = (slug: string, status: RecurringRecord['status'], extra: Partial<RecurringRecord> = {}): RecurringRecord => ({
  slug,
  descripcion: slug,
  categoria: 'servicios',
  tipo: "gasto" as const,
  montoTipico: 100,
  diaTipico: 10,
  status,
  source: 'auto',
  createdAt: '',
  updatedAt: '',
  ...extra,
});

describe('findNewCandidates', () => {
  it('solo devuelve detectados que no existen en REC# (cualquier estado cuenta como conocido)', () => {
    const detected = detectRecurring([
      txn('2026-05-16', 'Netflix', 108.7, { category: 'suscripciones' }),
      txn('2026-06-16', 'Netflix', 108.7, { category: 'suscripciones' }),
      txn('2026-05-06', 'Tigo', 329),
      txn('2026-06-06', 'Tigo', 329),
    ]);
    const known = [record(recurringSlug('suscripciones', 'Netflix'), 'rejected')];
    const nuevos = findNewCandidates(detected, known);
    expect(nuevos.map((c) => c.descripcion)).toEqual(['Tigo']);
  });
});

describe('recurringForAdvisor', () => {
  const netflixSlug = recurringSlug('suscripciones', 'Netflix');

  it('marca estado según lo aprendido, excluye rechazados y calcula si aún viene', () => {
    const history = [
      txn('2026-05-16', 'Netflix', 108.7, { category: 'suscripciones' }),
      txn('2026-06-16', 'Netflix', 108.7, { category: 'suscripciones' }),
      txn('2026-05-06', 'Tigo', 329),
      txn('2026-06-06', 'Tigo', 329),
      txn('2026-05-01', 'Comisión Bimóvil', 15),
      txn('2026-06-01', 'Comisión Bimóvil', 15),
    ];
    const detected = detectRecurring(history);
    const known = [
      record(netflixSlug, 'confirmed'),
      record(recurringSlug('servicios', 'Comisión Bimóvil'), 'rejected'),
    ];
    // hoy es día 11; este mes (julio) no hay pagos aún
    const advisor = recurringForAdvisor(detected, known, [], 11, '2026-07');

    const netflix = advisor.find((a) => a.descripcion === 'Netflix')!;
    expect(netflix.estado).toBe('confirmado');
    expect(netflix.yaPagadoEsteMes).toBe(false);
    expect(netflix.aunVieneEsteMes).toBe(true); // día 16 ≥ 11

    const tigo = advisor.find((a) => a.descripcion === 'Tigo')!;
    expect(tigo.estado).toBe('posible');
    expect(tigo.aunVieneEsteMes).toBe(false); // día 6 < 11 y no pagado

    expect(advisor.find((a) => a.descripcion.includes('Bimóvil'))).toBeUndefined();
  });

  it('ya pagado este mes apaga aunVieneEsteMes', () => {
    const history = [
      txn('2026-05-16', 'Netflix', 108.7, { category: 'suscripciones' }),
      txn('2026-06-16', 'Netflix', 108.7, { category: 'suscripciones' }),
    ];
    const julio = [txn('2026-07-10', 'Netflix', 108.7, { category: 'suscripciones' })];
    const advisor = recurringForAdvisor(detectRecurring(history), [], julio, 11, '2026-07');
    expect(advisor[0]!.yaPagadoEsteMes).toBe(true);
    expect(advisor[0]!.aunVieneEsteMes).toBe(false);
  });

  it('conserva confirmados que la heurística ya no ve', () => {
    const advisor = recurringForAdvisor([], [record('x|seguro-anual', 'confirmed', { descripcion: 'Seguro anual', montoTipico: 1200, diaTipico: 20 })], [], 11, '2026-07');
    expect(advisor).toHaveLength(1);
    expect(advisor[0]!.estado).toBe('confirmado');
    expect(advisor[0]!.aunVieneEsteMes).toBe(true);
  });

  it('paidThroughMonth marca pagado sin transacción (incidente Tigo/Apple 18-jul)', () => {
    const tigoSlug = recurringSlug('servicios', 'Tigo');
    const marcado = record(tigoSlug, 'confirmed', { descripcion: 'Tigo', montoTipico: 329, diaTipico: 6, paidThroughMonth: '2026-07' });
    // sin transacción de julio, pero marcado pagado este mes → no molesta
    const advisor = recurringForAdvisor([], [marcado], [], 20, '2026-07');
    expect(advisor[0]!.yaPagadoEsteMes).toBe(true);
    expect(advisor[0]!.aunVieneEsteMes).toBe(false);
    // el marcador de julio NO aplica en agosto
    const agosto = recurringForAdvisor([], [marcado], [], 20, '2026-08');
    expect(agosto[0]!.yaPagadoEsteMes).toBe(false);
  });
});
