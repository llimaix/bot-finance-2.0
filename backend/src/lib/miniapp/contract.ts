/**
 * Contrato de GET /api/dashboard (Mini App). Solo tipos y sin imports: el
 * frontend lo importa directamente (frontend/src/api.ts), así ambos lados
 * comparten una sola definición. Montos en CENTAVOS enteros; fechas yyyy-mm-dd.
 */

export type EstadoMeta = 'verde' | 'amarillo' | 'rojo';

export interface Dashboard {
  generadoEn: string;
  hoy: string;
  usuario: string | null;
  resumen: {
    disponible: number;
    deuda: number;
    neto: number;
    /** null si no hay ingresos declarados. */
    libre: number | null;
    libreDespues: number | null;
    proximoIngreso: { descripcion: string; fecha: string; monto: number; dias: number } | null;
  };
  cuentas: Array<{ id: string; nombre: string; tipo: 'banco' | 'efectivo' | 'billetera'; saldo: number; terminaciones: string[] }>;
  tarjetas: Array<{
    id: string;
    nombre: string;
    terminaciones: string[];
    limite: number;
    deudaActual: number;
    usoPct: number;
    pendiente: number;
    fechaPago: string;
    proximoCorte: string;
    consumoPeriodo: number;
    interesEstimado: number | null;
  }>;
  gastoMes: {
    mes: string;
    total: number;
    totalMesAnteriorMismoDia: number;
    proyeccion: number;
    porCategoria: Array<{ categoria: string; emoji: string; monto: number }>;
    porDia: Array<{ fecha: string; monto: number }>;
  };
  metas: Array<{ categoria: string; emoji: string; limite: number; gastado: number; pct: number; estado: EstadoMeta }>;
  historial: Array<{ fecha: string; disponible: number; deuda: number; libre: number | null }>;
  movimientos: Array<{
    fecha: string;
    descripcion: string;
    categoria: string;
    emoji: string;
    monto: number;
    tipo: 'gasto' | 'ingreso' | 'transferencia';
  }>;
}
