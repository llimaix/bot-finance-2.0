import { describe, expect, it } from 'vitest';
import { daysAgoGT, daysElapsedInMonthGT, daysInMonth, monthLabelES, monthPrefixGT, todayGT } from '../src/lib/dates';

describe('todayGT', () => {
  it('convierte UTC a fecha de Guatemala (UTC-6)', () => {
    // 23:30 UTC = 17:30 en Guatemala, mismo día
    expect(todayGT(new Date('2026-07-10T23:30:00Z'))).toBe('2026-07-10');
  });

  it('la madrugada UTC sigue siendo el día anterior en Guatemala', () => {
    // 03:00 UTC del día 11 = 21:00 del día 10 en Guatemala
    expect(todayGT(new Date('2026-07-11T03:00:00Z'))).toBe('2026-07-10');
  });

  it('cruza el año correctamente', () => {
    expect(todayGT(new Date('2027-01-01T02:00:00Z'))).toBe('2026-12-31');
  });
});

describe('daysAgoGT', () => {
  it('resta días calendario', () => {
    expect(daysAgoGT(6, new Date('2026-07-10T18:00:00Z'))).toBe('2026-07-04');
  });

  it('cruza el mes', () => {
    expect(daysAgoGT(6, new Date('2026-07-03T18:00:00Z'))).toBe('2026-06-27');
  });
});

describe('monthPrefixGT', () => {
  const now = new Date('2026-07-10T18:00:00Z');

  it('mes en curso', () => {
    expect(monthPrefixGT(0, now)).toBe('2026-07');
  });

  it('mes anterior', () => {
    expect(monthPrefixGT(-1, now)).toBe('2026-06');
  });

  it('cruza el año hacia atrás', () => {
    expect(monthPrefixGT(-1, new Date('2026-01-15T18:00:00Z'))).toBe('2025-12');
    expect(monthPrefixGT(-2, new Date('2026-01-15T18:00:00Z'))).toBe('2025-11');
  });
});

describe('daysElapsedInMonthGT / daysInMonth', () => {
  it('días transcurridos según hora de Guatemala', () => {
    expect(daysElapsedInMonthGT(new Date('2026-07-11T03:00:00Z'))).toBe(10);
  });

  it('días del mes, incluido febrero bisiesto', () => {
    expect(daysInMonth('2026-06')).toBe(30);
    expect(daysInMonth('2026-07')).toBe(31);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-02')).toBe(28);
  });
});

describe('monthLabelES', () => {
  it('etiqueta en español', () => {
    expect(monthLabelES('2026-06').toLowerCase()).toContain('junio');
    expect(monthLabelES('2026-06')).toContain('2026');
  });
});
