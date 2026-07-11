import { describe, expect, it } from 'vitest';
import { escapeHtml, formatQ, renderConfirmation, renderTxnLine, toCsv } from '../src/lib/format';
import type { Transaction } from '../src/lib/types';

const base: Transaction = {
  sk: 'TXN#2026-07-10#01ABC',
  date: '2026-07-10',
  shortId: 1,
  amount: 45,
  type: 'gasto',
  category: 'comida',
  method: 'efectivo',
  description: 'almuerzo',
  rawMessage: 'almuerzo Q45 en efectivo',
  createdAt: '2026-07-10T18:00:00Z',
};

describe('formatQ', () => {
  it('formato exacto con separador de miles', () => {
    expect(formatQ(45)).toBe('Q45.00');
    expect(formatQ(1500)).toBe('Q1,500.00');
    expect(formatQ(0.5)).toBe('Q0.50');
  });
});

describe('escapeHtml', () => {
  it('escapa lo que rompe parse_mode HTML', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('renderTxnLine', () => {
  it('gasto con método', () => {
    expect(renderTxnLine(base)).toBe('1. 🍽️ almuerzo — Q45.00 — efectivo');
  });

  it('depósito a ahorro sin método', () => {
    const dep: Transaction = {
      ...base,
      shortId: 3,
      amount: 1500,
      type: 'deposito',
      category: 'ahorro',
      method: 'na',
      description: 'ahorro',
    };
    expect(renderTxnLine(dep)).toBe('3. 🐷 Depósito: ahorro — Q1,500.00');
  });
});

describe('renderConfirmation', () => {
  it('mensaje completo con total y pie', () => {
    const msg = renderConfirmation({ txns: [base], today: '2026-07-10', totalSpentToday: 245, clarification: null });
    expect(msg).toContain('✅ Registrado (1 movimiento):');
    expect(msg).toContain('1. 🍽️ almuerzo — Q45.00 — efectivo');
    expect(msg).toContain('Total gastado hoy: Q245.00');
    expect(msg).toContain('corrige #2');
    expect(msg).not.toContain('📅'); // movimiento de hoy: sin marca de fecha
  });

  it('marca la fecha de los movimientos retroactivos', () => {
    const retro = { ...base, date: '2026-07-08', sk: 'TXN#2026-07-08#01X' };
    const msg = renderConfirmation({ txns: [retro], today: '2026-07-10', totalSpentToday: 0, clarification: null });
    expect(msg).toContain('· 📅 2026-07-08');
  });

  it('incluye la transcripción y la pregunta de aclaración', () => {
    const msg = renderConfirmation({
      txns: [base],
      today: '2026-07-10',
      totalSpentToday: 45,
      clarification: '¿Cuánto fue lo del taxi?',
      transcript: 'almuerzo cuarenta y cinco',
    });
    expect(msg).toContain('🎙️ Escuché: "almuerzo cuarenta y cinco"');
    expect(msg).toContain('❓ ¿Cuánto fue lo del taxi?');
  });
});

describe('toCsv', () => {
  it('genera CSV con BOM, encabezado y escape de comillas', () => {
    const txns: Transaction[] = [
      base,
      { ...base, sk: 'TXN#2026-07-09#01A', date: '2026-07-09', amount: 1500.5, description: 'compra "grande"' },
    ];
    const csv = toCsv(txns);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM para Excel
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('fecha,tipo,categoria,metodo,monto,descripcion');
    // orden por SK: el del día 09 primero
    expect(lines[1]).toBe('2026-07-09,gasto,comida,efectivo,1500.50,"compra ""grande"""');
    expect(lines[2]).toBe('2026-07-10,gasto,comida,efectivo,45.00,"almuerzo"');
  });
});
