import { describe, expect, it } from 'vitest';
import type { CicloTarjeta } from '../src/lib/v2/ciclos';
import type { Cuenta } from '../src/lib/v2/model';
import { alertasTarjetas, renderTarjetas } from '../src/lib/v2/tarjetas';
import type { TarjetaConCiclo } from '../src/lib/v2/tarjetas';

const cuenta = (over: Partial<NonNullable<Cuenta['credito']>> = {}): Cuenta => ({
  id: 'visa',
  nombre: 'Visa BAC',
  tipo: 'credito',
  entidadId: null,
  terminaciones: ['1111'],
  alias: [],
  semillaCentavos: 0,
  asOf: '2026-10-01',
  estimada: false,
  activa: true,
  credito: { limiteCentavos: 1_000_000, diaCorte: 15, diaPago: 5, ajustePago: 'siguiente_habil', diasAviso: [5, 2, 0], ...over },
});

const ciclo = (over: Partial<CicloTarjeta> = {}): CicloTarjeta => ({
  cuentaId: 'visa',
  ultimoCorte: '2026-11-15',
  proximoCorte: '2026-12-15',
  fechaPago: '2026-12-07',
  deudaAlCorte: 300_000,
  pagado: 100_000,
  pendiente: 200_000,
  consumoPeriodo: 50_000,
  deudaActual: 250_000,
  interesEstimado: 7_000,
  aproximado: false,
  ...over,
});

const t = (c: Partial<CicloTarjeta> = {}, cred: Partial<NonNullable<Cuenta['credito']>> = {}): TarjetaConCiclo[] => [
  { cuenta: cuenta(cred), ciclo: ciclo(c) },
];

describe('/tarjetas', () => {
  it('muestra corte, pagado, pendiente con plazo, interés, periodo y uso del límite', () => {
    const html = renderTarjetas(t(), '2026-11-26');
    for (const parte of [
      'Visa BAC ••1111',
      'Cortó el 15-nov: Q3,000.00 · pagado Q1,000.00',
      'Pendiente <b>Q2,000.00</b> · pagar antes del 7-dic (en 11 días)',
      'interés estimado: ~Q70.00',
      'Periodo actual: Q500.00 · próximo corte 15-dic',
      'Deuda total Q2,500.00 de Q10,000.00 (25%)',
    ]) {
      expect(html, parte).toContain(parte);
    }
  });

  it('pago cubierto y vencido', () => {
    expect(renderTarjetas(t({ pendiente: 0 }), '2026-11-26')).toContain('✅ Pago del corte cubierto');
    expect(renderTarjetas(t(), '2026-12-08')).toContain('⚠️ Pendiente <b>Q2,000.00</b> · venció el 7-dic');
  });

  it('sin tarjetas explica cómo agregarlas', () => {
    expect(renderTarjetas([], '2026-11-26')).toContain('No tienes tarjetas');
  });
});

describe('avisos del guardián', () => {
  it('3 días antes del corte', () => {
    expect(alertasTarjetas(t(), '2026-12-12').join()).toContain('corta el 15-dic; llevas Q500.00');
  });

  it('el día siguiente al corte', () => {
    expect(alertasTarjetas(t(), '2026-11-16').join()).toContain('cortó en Q3,000.00. Pago antes del 7-dic');
  });

  it('según diasAviso antes del pago, con interés estimado', () => {
    const a = alertasTarjetas(t(), '2026-12-05').join();
    expect(a).toContain('Faltan 2 días para el pago');
    expect(a).toContain('~Q70.00');
    expect(alertasTarjetas(t(), '2026-12-07').join()).toContain('Hoy vence el pago');
  });

  it('pago vencido con pendiente', () => {
    expect(alertasTarjetas(t(), '2026-12-09').join()).toContain('⚠️ Venció el pago');
  });

  it('uso mayor al 80 % del límite', () => {
    expect(alertasTarjetas(t({ deudaActual: 850_000 }), '2026-11-26').join()).toContain('al 85% de su límite');
  });

  it('un día sin eventos no genera avisos', () => {
    expect(alertasTarjetas(t(), '2026-11-26')).toEqual([]);
  });

  it('sin pendiente no avisa del pago', () => {
    expect(alertasTarjetas(t({ pendiente: 0 }), '2026-12-05')).toEqual([]);
  });
});
