/**
 * Datos FICTICIOS solo para desarrollo local (pnpm dev, fuera de Telegram).
 * No se incluyen en el build de producción (ver api.ts). Nunca datos reales.
 */
import type { Dashboard } from './api';

export function demoDashboard(): Dashboard {
  const hoy = new Date().toISOString().slice(0, 10);
  const mes = hoy.slice(0, 7);
  const dia = Number(hoy.slice(8, 10));
  const d = (n: number) => `${mes}-${String(n).padStart(2, '0')}`;
  const back = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const ruido = (i: number) => Math.round((Math.sin(i * 1.7) + 1.2) * 9_000 + (i % 6 === 0 ? 40_000 : 0));

  return {
    generadoEn: new Date().toISOString(),
    hoy,
    usuario: 'Demo',
    resumen: {
      disponible: 812_550,
      deuda: 315_020,
      prestamos: 1_850_000,
      neto: -1_352_470,
      libre: 286_400,
      libreDespues: 742_900,
      proximoIngreso: { descripcion: 'Salario', fecha: d(Math.min(dia + 6, 28)), monto: 900_000, dias: 6 },
    },
    cuentas: [
      { id: 'banco-a', nombre: 'Banco A Monetaria', tipo: 'banco', saldo: 645_300, terminaciones: ['0001'] },
      { id: 'ahorro', nombre: 'Banco B Ahorro', tipo: 'banco', saldo: 120_000, terminaciones: [] },
      { id: 'efectivo', nombre: 'Efectivo', tipo: 'efectivo', saldo: 32_250, terminaciones: [] },
      { id: 'billetera', nombre: 'Billetera móvil', tipo: 'billetera', saldo: 15_000, terminaciones: [] },
    ],
    prestamos: [
      { id: 'prestamo-demo', nombre: 'Préstamo Banco C', deuda: 1_850_000, cuota: 95_000, diaPago: 5, vence: '2030-06-05' },
    ],
    tarjetas: [
      {
        id: 'visa-demo',
        nombre: 'Visa Demo',
        terminaciones: ['1111'],
        limite: 1_500_000,
        deudaActual: 248_020,
        usoPct: 17,
        pendiente: 180_000,
        fechaPago: d(Math.min(dia + 4, 28)),
        proximoCorte: d(Math.min(dia + 12, 28)),
        consumoPeriodo: 68_020,
        interesEstimado: 6_300,
      },
      {
        id: 'mc-demo',
        nombre: 'Mastercard Demo',
        terminaciones: ['2222'],
        limite: 80_000,
        deudaActual: 67_000,
        usoPct: 84,
        pendiente: 0,
        fechaPago: d(Math.min(dia + 15, 28)),
        proximoCorte: d(Math.min(dia + 2, 28)),
        consumoPeriodo: 67_000,
        interesEstimado: null,
      },
    ],
    gastoMes: {
      mes,
      total: 538_400,
      totalMesAnteriorMismoDia: 602_100,
      proyeccion: 1_090_000,
      porCategoria: [
        { categoria: 'supermercado', emoji: '🛒', monto: 182_300 },
        { categoria: 'comida', emoji: '🍔', monto: 121_500 },
        { categoria: 'transporte', emoji: '🚗', monto: 86_000 },
        { categoria: 'servicios', emoji: '💡', monto: 64_200 },
        { categoria: 'salud', emoji: '💊', monto: 38_400 },
        { categoria: 'entretenimiento', emoji: '🎬', monto: 27_000 },
        { categoria: 'otros', emoji: '📦', monto: 19_000 },
      ],
      porDia: Array.from({ length: dia }, (_, i) => ({ fecha: d(i + 1), monto: ruido(i + 1) })),
    },
    metas: [
      { categoria: 'comida', emoji: '🍔', limite: 150_000, gastado: 121_500, pct: 81, estado: 'amarillo' },
      { categoria: 'supermercado', emoji: '🛒', limite: 300_000, gastado: 182_300, pct: 61, estado: 'verde' },
      { categoria: 'entretenimiento', emoji: '🎬', limite: 25_000, gastado: 27_000, pct: 108, estado: 'rojo' },
    ],
    historial: Array.from({ length: 45 }, (_, i) => {
      const k = 44 - i;
      const base = 700_000 + Math.round(Math.sin(i / 4) * 90_000) - (i % 15) * 12_000;
      return { fecha: back(k), disponible: base, deuda: 280_000 + (i % 15) * 4_000, libre: base - 380_000 };
    }),
    movimientos: [
      { fecha: hoy, descripcion: 'Supermercado', categoria: 'supermercado', emoji: '🛒', monto: 45_620, tipo: 'gasto' },
      { fecha: hoy, descripcion: 'Almuerzo', categoria: 'comida', emoji: '🍔', monto: 8_500, tipo: 'gasto' },
      { fecha: back(1), descripcion: 'Gasolina', categoria: 'transporte', emoji: '🚗', monto: 30_000, tipo: 'gasto' },
      { fecha: back(1), descripcion: 'Pago de tarjeta', categoria: 'deuda', emoji: '💳', monto: 100_000, tipo: 'transferencia' },
      { fecha: back(2), descripcion: 'Salario', categoria: 'salario', emoji: '💰', monto: 900_000, tipo: 'ingreso' },
      { fecha: back(3), descripcion: 'Farmacia', categoria: 'salud', emoji: '💊', monto: 12_800, tipo: 'gasto' },
    ],
  };
}
