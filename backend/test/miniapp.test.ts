import { describe, expect, it } from 'vitest';
import { initDataHash, validateInitData } from '../src/lib/miniapp/auth';
import { buildDashboard } from '../src/lib/miniapp/dashboard';
import type { DashboardInput } from '../src/lib/miniapp/dashboard';
import type { Transaction } from '../src/lib/types';
import type { Cuenta } from '../src/lib/v2/model';

// Token y usuario ficticios: nunca datos reales en tests.
const TOKEN = '123456:TEST-token-ficticio';
const NOW = 1_800_000_000;

function initData(over: Record<string, string> = {}, token = TOKEN): string {
  const params = new URLSearchParams({
    auth_date: String(NOW - 60),
    query_id: 'AAE-test',
    user: JSON.stringify({ id: 42, first_name: 'Prueba' }),
    ...over,
  });
  params.set('hash', initDataHash(params, token));
  return params.toString();
}

const opts = { botToken: TOKEN, allowedUserId: '42', maxAgeSeconds: 3600, nowSeconds: NOW };

describe('validación del initData de Telegram', () => {
  it('acepta un initData firmado por el bot y del usuario permitido', () => {
    expect(validateInitData(initData(), opts)).toEqual({ ok: true, userId: '42', firstName: 'Prueba' });
  });

  it('rechaza datos alterados después de firmar', () => {
    const alterado = initData().replace('Prueba', 'Otro');
    expect(validateInitData(alterado, opts)).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('rechaza una firma hecha con otro token', () => {
    expect(validateInitData(initData({}, '999:otro'), opts)).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('rechaza un initData viejo (anti-replay)', () => {
    expect(validateInitData(initData({ auth_date: String(NOW - 7200) }), opts)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rechaza a otro usuario aunque la firma sea válida', () => {
    const otro = initData({ user: JSON.stringify({ id: 7, first_name: 'X' }) });
    expect(validateInitData(otro, opts)).toEqual({ ok: false, reason: 'forbidden_user' });
  });

  it('rechaza ausente o mal formado', () => {
    expect(validateInitData(undefined, opts)).toEqual({ ok: false, reason: 'missing' });
    expect(validateInitData('hash=zz&auth_date=1', opts)).toEqual({ ok: false, reason: 'malformed' });
  });
});

const cuenta = (id: string, tipo: Cuenta['tipo']): Cuenta => ({
  id,
  nombre: id.toUpperCase(),
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

const txn = (date: string, montoCentavos: number, category: string, tipo: 'gasto' | 'ingreso' = 'gasto'): Transaction =>
  ({
    sk: `TXN#${date}#${category}${montoCentavos}`,
    date,
    amount: montoCentavos / 100,
    type: tipo,
    category,
    description: `${category} de prueba`,
    v2: { montoCentavos, tipo, origen: tipo === 'gasto' ? 'bi' : null, destino: tipo === 'ingreso' ? 'bi' : null, cuentaFuente: 'usuario' },
  }) as Transaction;

const base = (): DashboardInput => ({
  hoy: '2026-11-03',
  generadoEn: '2026-11-03T15:00:00.000Z',
  usuario: 'Prueba',
  saldos: [
    { cuenta: cuenta('bi', 'banco'), saldoCentavos: 500_000, movimientos: 1 },
    { cuenta: cuenta('visa', 'credito'), saldoCentavos: -250_000, movimientos: 1 },
  ],
  tarjetas: [],
  libre: {
    disponible: 500_000,
    deuda: 250_000,
    ingreso: { descripcion: 'Salario', fecha: '2026-11-13', montoCentavos: 800_000 },
    dias: 10,
    tarjetas: [],
    recurrentes: [],
    gastoVariable: 0,
    libreHastaIngreso: 400_000,
    despues: null,
  },
  monthTxns: [
    txn('2026-11-01', 10_000, 'comida'),
    txn('2026-11-03', 5_000, 'comida'),
    txn('2026-11-02', 20_000, 'transporte'),
    txn('2026-11-02', 800_000, 'salario', 'ingreso'),
  ],
  prevTxns: [txn('2026-10-02', 7_000, 'comida'), txn('2026-10-20', 99_000, 'comida')],
  metas: [],
  fotos: [
    { fecha: '2026-11-02', disponibleCentavos: 510_000, deudaCentavos: 250_000, libreCentavos: 410_000, libreDespuesCentavos: null, proximoIngreso: null },
    { fecha: '2026-11-01', disponibleCentavos: 520_000, deudaCentavos: 240_000, libreCentavos: null, libreDespuesCentavos: null, proximoIngreso: null },
  ],
});

describe('dashboard', () => {
  it('resumen: disponible, deuda, neto, libre y días al próximo ingreso', () => {
    expect(buildDashboard(base()).resumen).toEqual({
      disponible: 500_000,
      deuda: 250_000,
      neto: 250_000,
      libre: 400_000,
      libreDespues: null,
      proximoIngreso: { descripcion: 'Salario', fecha: '2026-11-13', monto: 800_000, dias: 10 },
    });
  });

  it('solo cuentas que no son de crédito en "cuentas"', () => {
    expect(buildDashboard(base()).cuentas.map((c) => c.id)).toEqual(['bi']);
  });

  it('gasto del mes: total sin ingresos, por categoría ordenada, por día y mes anterior al mismo día', () => {
    const g = buildDashboard(base()).gastoMes;
    expect(g.total).toBe(35_000);
    expect(g.porCategoria.map((c) => [c.categoria, c.monto])).toEqual([
      ['transporte', 20_000],
      ['comida', 15_000],
    ]);
    expect(g.porDia).toEqual([
      { fecha: '2026-11-01', monto: 10_000 },
      { fecha: '2026-11-02', monto: 20_000 },
      { fecha: '2026-11-03', monto: 5_000 },
    ]);
    expect(g.totalMesAnteriorMismoDia).toBe(7_000); // el del 20-oct queda fuera
    expect(g.proyeccion).toBe(Math.round((35_000 / 3) * 30));
  });

  it('historial ordenado por fecha y movimientos más recientes primero', () => {
    const d = buildDashboard(base());
    expect(d.historial.map((h) => h.fecha)).toEqual(['2026-11-01', '2026-11-02']);
    expect(d.movimientos[0]).toMatchObject({ fecha: '2026-11-03', monto: 5_000, tipo: 'gasto' });
  });
});
