import { describe, expect, it } from 'vitest';
import { summarizeSearch } from '../src/lib/search';
import type { Transaction } from '../src/lib/types';

let n = 0;
function txn(date: string, description: string, amount: number, partial: Partial<Transaction> = {}): Transaction {
  n += 1;
  return {
    sk: `TXN#${date}#s${n}`,
    date,
    shortId: n,
    amount,
    type: 'gasto',
    category: 'salud',
    method: 'debito',
    description,
    rawMessage: '',
    createdAt: `${date}T12:00:00Z`,
    ...partial,
  };
}

const base = [
  txn('2026-05-11', 'Farmacia Cruz Verde', 551, { method: 'credito' }),
  txn('2026-05-25', 'Droguería y Farmacia Arroyo', 165),
  txn('2026-06-04', 'Farmacias Galeno 95', 196.66, { method: 'credito' }),
  txn('2026-05-15', 'Salario 1ra quincena', 7500, { type: 'ingreso', category: 'otros', method: 'na' }),
  txn('2026-05-10', 'Combustibles de Confianza', 455.03, { category: 'transporte', method: 'credito' }),
];

describe('summarizeSearch', () => {
  it('filtra por texto sin importar tildes/mayúsculas y agrega por tipo', () => {
    const res = summarizeSearch(base, { texto: 'farmacia' });
    expect(res.encontrados).toBe(3);
    expect(res.porTipo.gasto).toEqual({ total: 912.66, count: 3 });
    expect(res.gastosPorCategoria.salud).toBe(912.66);
  });

  it('filtra por categoría (normalizada) y ordena movimientos por fecha desc', () => {
    const res = summarizeSearch(base, { categoria: 'Salud' });
    expect(res.encontrados).toBe(3);
    expect(res.movimientos[0]!.fecha).toBe('2026-06-04');
  });

  it('sin filtros devuelve todo, con ingresos separados por tipo', () => {
    const res = summarizeSearch(base, {});
    expect(res.encontrados).toBe(5);
    expect(res.porTipo.ingreso).toEqual({ total: 7500, count: 1 });
    expect(res.gastosPorCategoria.transporte).toBe(455.03);
  });

  it('recorta el listado a 20 y lo anota', () => {
    const many = Array.from({ length: 25 }, (_, i) => txn('2026-06-01', `mov ${i}`, 10));
    const res = summarizeSearch(many, {});
    expect(res.movimientos).toHaveLength(20);
    expect(res.nota).toContain('25');
  });
});
