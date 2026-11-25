import { describe, expect, it } from 'vitest';
import type { CicloTarjeta } from '../src/lib/v2/ciclos';
import type { IngresoEsperado } from '../src/lib/v2/ingresos';
import { calcularLibre, renderLibre } from '../src/lib/v2/libre';
import type { LibreInput } from '../src/lib/v2/libre';
import type { Cuenta } from '../src/lib/v2/model';
import type { SaldoV2 } from '../src/lib/v2/saldos';

const cuenta = (id: string, tipo: Cuenta['tipo']): Cuenta => ({
  id,
  nombre: id,
  tipo,
  entidadId: null,
  terminaciones: [],
  alias: [],
  semillaCentavos: 0,
  asOf: '2026-11-01',
  estimada: false,
  activa: true,
  ...(tipo === 'credito'
    ? { credito: { limiteCentavos: 1_000_000, diaCorte: 15, diaPago: 5, ajustePago: 'ninguno' as const, diasAviso: [] } }
    : {}),
});
const saldo = (c: Cuenta, saldoCentavos: number): SaldoV2 => ({ cuenta: c, saldoCentavos, movimientos: 0 });
const VISA = cuenta('visa', 'credito');

const salario: IngresoEsperado = {
  slug: 'salario',
  descripcion: 'Salario',
  montoCentavos: 800_000,
  cuentaDestino: 'bi',
  dias: [15, 31],
  ajuste: 'ninguno',
  activo: true,
};

const ciclo = (over: Partial<CicloTarjeta>): CicloTarjeta => ({
  cuentaId: 'visa',
  ultimoCorte: '2026-11-15',
  proximoCorte: '2026-12-15',
  fechaPago: '2026-12-05',
  deudaAlCorte: 200_000,
  pagado: 0,
  pendiente: 200_000,
  consumoPeriodo: 50_000,
  deudaActual: 250_000,
  interesEstimado: null,
  aproximado: false,
  ...over,
});

const base = (over: Partial<LibreInput> = {}): LibreInput => ({
  hoy: '2026-11-22',
  saldos: [saldo(cuenta('bi', 'banco'), 500_000), saldo(cuenta('efectivo', 'efectivo'), 20_000), saldo(VISA, -250_000)],
  tarjetas: [{ cuenta: VISA, ciclo: ciclo({}) }],
  proximos: [
    { ingreso: salario, fecha: '2026-11-30' },
    { ingreso: salario, fecha: '2026-12-15' },
  ],
  recurrentes: [
    { descripcion: 'Netflix', montoCentavos: 8_000, dia: 25, aunVieneEsteMes: true },
    { descripcion: 'Gimnasio', montoCentavos: 30_000, dia: 1, aunVieneEsteMes: true },
  ],
  gastoDiarioCentavos: 10_000,
  ...over,
});

describe('libre hasta el próximo ingreso', () => {
  it('disponible − recurrentes pendientes − día a día (la tarjeta se paga después del ingreso)', () => {
    const l = calcularLibre(base());
    expect(l).toMatchObject({ disponible: 520_000, deuda: 250_000, dias: 8, gastoVariable: 80_000 });
    expect(l.tarjetas).toEqual([]); // vence el 5-dic, después del 30-nov
    expect(l.recurrentes.map((r) => r.concepto)).toEqual(['Netflix']); // el 25; el gimnasio cae el 1-dic
    expect(l.libreHastaIngreso).toBe(520_000 - 8_000 - 80_000);
  });

  it('un pago de tarjeta que vence antes del ingreso se descuenta', () => {
    const l = calcularLibre(base({ tarjetas: [{ cuenta: VISA, ciclo: ciclo({ fechaPago: '2026-11-28' }) }] }));
    expect(l.tarjetas).toEqual([{ concepto: 'visa', fecha: '2026-11-28', montoCentavos: 200_000 }]);
    expect(l.libreHastaIngreso).toBe(520_000 - 200_000 - 8_000 - 80_000);
  });

  it('un recurrente ya pagado este mes no se descuenta', () => {
    const l = calcularLibre(base({ recurrentes: [{ descripcion: 'Netflix', montoCentavos: 8_000, dia: 25, aunVieneEsteMes: false }] }));
    expect(l.recurrentes).toEqual([]);
  });

  it('después del ingreso: + salario − tarjeta del 5-dic (consumo del periodo) − recurrentes − día a día', () => {
    const l = calcularLibre(base());
    // Hasta 15-dic: tarjeta del próximo corte (15-dic) vence el 5-ene → fuera; la del corte actual ya
    // se contó como pendiente solo si vencía antes del 30-nov. Gimnasio el 1-dic. 15 días de día a día.
    const esperado = l.libreHastaIngreso! + 800_000 - 30_000 - 10_000 * 15;
    expect(l.despues).toEqual({ hasta: '2026-12-15', libre: esperado });
  });
});

describe('render', () => {
  it('sin ingresos declarados explica cómo declararlos', () => {
    const html = renderLibre(calcularLibre(base({ proximos: [] })), 0);
    expect(html).toContain('Disponible hoy: <b>Q5,200.00</b>');
    expect(html).toContain('me pagan Q8,000');
  });

  it('muestra el desglose y el libre después del ingreso', () => {
    const html = renderLibre(calcularLibre(base()), 10_000);
    for (const parte of ['Libre hasta tu próximo ingreso', 'Salario el 30-nov · en 8 días', '− Recurrentes: Q80.00 (Netflix 25-nov)', '− Día a día: Q800.00 (Q100.00 × 8 días)', 'libre hasta el 15-dic', 'Deuda de tarjetas: Q2,500.00']) {
      expect(html, parte).toContain(parte);
    }
  });
});
