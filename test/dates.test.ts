import { describe, expect, it } from 'vitest';
import {
  daysAgoGT,
  daysElapsedInMonthGT,
  daysInMonth,
  monthLabelES,
  monthPrefixGT,
  normalizeParsedDate,
  todayGT,
  weekdayGT,
} from '../src/lib/dates';

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

describe('normalizeParsedDate', () => {
  const today = '2026-07-10';

  it('acepta fechas pasadas válidas', () => {
    expect(normalizeParsedDate('2026-07-08', today)).toBe('2026-07-08');
    expect(normalizeParsedDate('2025-12-31', today)).toBe('2025-12-31');
  });

  it('null o formato inválido caen en hoy', () => {
    expect(normalizeParsedDate(null, today)).toBe(today);
    expect(normalizeParsedDate('ayer', today)).toBe(today);
    expect(normalizeParsedDate('08/07/2026', today)).toBe(today);
  });

  it('rechaza futuro, fechas imposibles y más de un año atrás', () => {
    expect(normalizeParsedDate('2026-07-11', today)).toBe(today);
    expect(normalizeParsedDate('2026-02-31', today)).toBe(today);
    expect(normalizeParsedDate('2024-01-01', today)).toBe(today);
  });
});

describe('weekdayGT', () => {
  it('día de semana en español según hora de Guatemala', () => {
    // 2026-07-10 es viernes
    expect(weekdayGT(new Date('2026-07-10T18:00:00Z')).toLowerCase()).toBe('viernes');
  });
});

describe('monthLabelES', () => {
  it('etiqueta en español', () => {
    expect(monthLabelES('2026-06').toLowerCase()).toContain('junio');
    expect(monthLabelES('2026-06')).toContain('2026');
  });
});

describe('calendario de pagos (15 y fin de mes, ajustado a día hábil)', () => {
  it('julio 2026: 15 (miércoles) y 31 (viernes) quedan tal cual', async () => {
    const { paydaysOfMonth } = await import('../src/lib/dates');
    expect(paydaysOfMonth('2026-07')).toEqual(['2026-07-15', '2026-07-31']);
  });

  it('sábado retrocede a viernes: 15-ago-2026 → 14; 31-oct-2026 → 30', async () => {
    const { paydaysOfMonth } = await import('../src/lib/dates');
    expect(paydaysOfMonth('2026-08')[0]).toBe('2026-08-14');
    expect(paydaysOfMonth('2026-10')[1]).toBe('2026-10-30');
  });

  it('domingo retrocede a viernes: 15-nov-2026 → 13; 28-feb-2027 → 26', async () => {
    const { paydaysOfMonth } = await import('../src/lib/dates');
    expect(paydaysOfMonth('2026-11')[0]).toBe('2026-11-13');
    expect(paydaysOfMonth('2027-02')[1]).toBe('2027-02-26');
  });

  it('nextPaydayAfter cruza al mes siguiente cuando toca', async () => {
    const { nextPaydayAfter } = await import('../src/lib/dates');
    expect(nextPaydayAfter('2026-07-14')).toBe('2026-07-15'); // "mañana me pagan"
    expect(nextPaydayAfter('2026-07-15')).toBe('2026-07-31');
    expect(nextPaydayAfter('2026-07-31')).toBe('2026-08-14'); // 15-ago es sábado
  });
});

describe('applySalaryCalendar', () => {
  it('reemplaza el día observado por el del calendario y revive aunVieneEsteMes', async () => {
    const { applySalaryCalendar } = await import('../src/lib/recurring');
    const base = {
      categoria: 'otros',
      tipo: 'ingreso' as const,
      montoTipico: 6284,
      estado: 'confirmado' as const,
      yaPagadoEsteMes: false,
    };
    const [q1, q2] = applySalaryCalendar(
      [
        { ...base, descripcion: 'Salario 1ra quincena', diaTipicoDePago: 15, aunVieneEsteMes: false },
        // día observado 25 con hoy=28: el modelo viejo lo daba por perdido
        { ...base, descripcion: 'Salario 2da quincena', diaTipicoDePago: 25, aunVieneEsteMes: false },
      ],
      [15, 31],
      28,
    );
    expect(q1!.diaTipicoDePago).toBe(15);
    expect(q1!.aunVieneEsteMes).toBe(false); // el 15 ya pasó y no está pagado: no viene
    expect(q2!.diaTipicoDePago).toBe(31);
    expect(q2!.aunVieneEsteMes).toBe(true); // pago real el 31: SÍ viene
  });

  it('no toca gastos ni ingresos que no son salario', async () => {
    const { applySalaryCalendar } = await import('../src/lib/recurring');
    const gasto = {
      descripcion: 'Universidad',
      categoria: 'educacion',
      tipo: 'gasto' as const,
      montoTipico: 1840,
      diaTipicoDePago: 6,
      estado: 'confirmado' as const,
      yaPagadoEsteMes: true,
      aunVieneEsteMes: false,
    };
    expect(applySalaryCalendar([gasto], [15, 31], 28)).toEqual([gasto]);
  });
});
