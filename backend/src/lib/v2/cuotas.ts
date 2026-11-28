/**
 * Compras a cuotas sin intereses (Visacuotas a tasa cero). PURO (sin IO).
 *
 * Una compra a cuotas NO entra completa a la tarjeta: en cada corte se carga
 * una cuota (total / número de cuotas; la última absorbe los centavos que
 * sobran). La primera cuota cae en el primer corte en o después de la compra,
 * igual que una compra normal (ciclos.ts cuenta el día del corte en ese corte).
 *
 * El banco bloquea el total desde el día de la compra: lo que falta facturar
 * se resta del disponible de la tarjeta aunque todavía no sea deuda del ciclo.
 *
 * Si una cuota no se paga a tiempo, queda en el pendiente del ciclo y genera
 * interés con la tasa de la tarjeta como cualquier consumo (ciclos.ts).
 */
import { z } from 'zod';
import { escapeHtml } from '../format';
import type { TransactionV2 } from '../types';
import { normalizeAlias } from './aliases';
import { corteDelMes } from './ciclos';
import { findCuenta, slugify } from './config';
import type { ConfigSnapshot, Plan } from './config';
import type { Cuenta } from './model';
import { formatCents, toCents } from './money';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug en minúsculas con guiones');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha yyyy-mm-dd');

export const MAX_CUOTAS = 60;

export const planCuotasSchema = z.object({
  id: slug,
  tarjetaId: slug,
  descripcion: z.string().min(1).max(80),
  categoria: z.string().min(1),
  montoCentavos: z.number().int().positive(),
  cuotas: z.number().int().min(2).max(MAX_CUOTAS),
  fechaCompra: isoDate,
  activo: z.boolean(),
});
export type PlanCuotas = z.infer<typeof planCuotasSchema>;

export interface Cuota {
  numero: number;
  fecha: string;
  montoCentavos: number;
}

/** Primer día del mes `k` meses después del mes de `fecha`. */
function inicioDeMes(fecha: string, k: number): string {
  const d = new Date(Date.UTC(Number(fecha.slice(0, 4)), Number(fecha.slice(5, 7)) - 1 + k, 1));
  return d.toISOString().slice(0, 10);
}

/** Monto de la cuota `numero` (1..n): partes iguales; la última se queda con el residuo. */
export function montoCuota(plan: Pick<PlanCuotas, 'montoCentavos' | 'cuotas'>, numero: number): number {
  const base = Math.floor(plan.montoCentavos / plan.cuotas);
  return numero === plan.cuotas ? plan.montoCentavos - base * (plan.cuotas - 1) : base;
}

/** Todas las cuotas del plan con la fecha de corte en que se cargan. */
export function calendarioCuotas(plan: PlanCuotas, diaCorte: number): Cuota[] {
  const corteCompra = corteDelMes(diaCorte, plan.fechaCompra);
  const desfase = corteCompra >= plan.fechaCompra ? 0 : 1;
  return Array.from({ length: plan.cuotas }, (_, i) => ({
    numero: i + 1,
    fecha: corteDelMes(diaCorte, inicioDeMes(plan.fechaCompra, desfase + i)),
    montoCentavos: montoCuota(plan, i + 1),
  }));
}

/** Cuotas ya cargadas a la tarjeta al día `hoy` (corte en o antes de hoy). */
export function cuotasVencidas(plan: PlanCuotas, diaCorte: number, hoy: string): Cuota[] {
  return calendarioCuotas(plan, diaCorte).filter((c) => c.fecha <= hoy);
}

/** Lo que falta cargar de un plan activo (0 si está cancelado). */
export function porFacturarPlan(plan: PlanCuotas, diaCorte: number, hoy: string): number {
  if (!plan.activo) return 0;
  return calendarioCuotas(plan, diaCorte)
    .filter((c) => c.fecha > hoy)
    .reduce((a, c) => a + c.montoCentavos, 0);
}

/** Lo que falta cargar de todos los planes activos de una tarjeta. */
export function porFacturarTarjeta(planes: ReadonlyArray<PlanCuotas>, tarjeta: Cuenta, hoy: string): number {
  if (!tarjeta.credito) return 0;
  const diaCorte = tarjeta.credito.diaCorte;
  return planes
    .filter((p) => p.tarjetaId === tarjeta.id)
    .reduce((a, p) => a + porFacturarPlan(p, diaCorte, hoy), 0);
}

/** SK determinista de cada cuota: el guardián puede correr varias veces sin duplicarla. */
export const cuotaSk = (planId: string, cuota: Pick<Cuota, 'numero' | 'fecha'>): string =>
  `TXN#${cuota.fecha}#CUO-${planId}-${String(cuota.numero).padStart(2, '0')}`;

/** SK del cargo del saldo restante cuando el plan se liquida antes de tiempo. */
export const restoSk = (planId: string, fecha: string): string => `TXN#${fecha}#CUO-${planId}-resto`;

/** Campos del movimiento de una cuota (gasto en la tarjeta con la categoría de la compra). */
export function movimientoCuota(
  plan: PlanCuotas,
  cuota: Cuota,
): { date: string; category: string; description: string; v2: TransactionV2 } {
  return {
    date: cuota.fecha,
    category: plan.categoria,
    description: `${plan.descripcion} (cuota ${cuota.numero}/${plan.cuotas})`,
    v2: { montoCentavos: cuota.montoCentavos, tipo: 'gasto', origen: plan.tarjetaId, destino: null, cuentaFuente: 'usuario' },
  };
}

/** Plan por id o descripción (sin acentos ni mayúsculas); solo entre los activos. */
export function findPlan(ref: string, planes: ReadonlyArray<PlanCuotas>): PlanCuotas | undefined {
  const key = normalizeAlias(ref);
  return planes.find((p) => p.activo && (p.id === key || normalizeAlias(p.descripcion) === key));
}

export interface CompraCuotasInput {
  /** Nombre, alias o terminación de la tarjeta. */
  tarjeta: string;
  descripcion: string;
  categoria: string;
  /** Monto TOTAL de la compra en quetzales. */
  montoTotal: number;
  cuotas: number;
  /** yyyy-mm-dd; null = hoy. */
  fechaCompra: string | null;
}

/** Valida la compra y arma el plan. No escribe nada. */
export function planCompraCuotas(
  input: CompraCuotasInput,
  snap: ConfigSnapshot,
  planes: ReadonlyArray<PlanCuotas>,
  categorias: ReadonlyArray<string>,
  hoy: string,
): Plan<PlanCuotas> {
  const errors: string[] = [];
  const tarjeta = findCuenta(input.tarjeta, snap.cuentas.filter((c) => c.activa));
  if (!tarjeta) errors.push(`No encontré la tarjeta "${input.tarjeta}". Pregunta al usuario cuál es.`);
  else if (tarjeta.tipo !== 'credito' || !tarjeta.credito) errors.push(`"${tarjeta.nombre}" no es una tarjeta de crédito: las cuotas solo van en tarjetas.`);
  if (!categorias.includes(input.categoria)) {
    errors.push(`La categoría "${input.categoria}" no existe. Usa una de: ${categorias.join(', ')}.`);
  }
  if (!Number.isFinite(input.montoTotal) || toCents(input.montoTotal) <= 0) errors.push('El monto total debe ser mayor que 0.');
  if (!Number.isInteger(input.cuotas) || input.cuotas < 2 || input.cuotas > MAX_CUOTAS) {
    errors.push(`El número de cuotas debe estar entre 2 y ${MAX_CUOTAS}.`);
  }
  const fechaCompra = input.fechaCompra ?? hoy;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaCompra) || fechaCompra > hoy) errors.push('La fecha de compra debe ser hoy o una fecha pasada (yyyy-mm-dd).');
  if (errors.length > 0 || !tarjeta) return { ok: false, errors };

  const descripcion = input.descripcion.trim().slice(0, 80) || 'Compra a cuotas';
  const taken = new Set(planes.map((p) => p.id));
  const base = slugify(descripcion);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;

  const plan: PlanCuotas = {
    id,
    tarjetaId: tarjeta.id,
    descripcion,
    categoria: input.categoria,
    montoCentavos: toCents(input.montoTotal),
    cuotas: input.cuotas,
    fechaCompra,
    activo: true,
  };
  const parsed = planCuotasSchema.safeParse(plan);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, errors: parsed.error.issues.map((i) => i.message) };
}

/** Una línea por plan activo para /tarjetas y el contexto del agente. */
export function resumenPlan(plan: PlanCuotas, diaCorte: number, hoy: string): string {
  const cargadas = cuotasVencidas(plan, diaCorte, hoy).length;
  return `${plan.descripcion}: cuota ${cargadas}/${plan.cuotas} de ${formatCents(montoCuota(plan, 1))} · por facturar ${formatCents(porFacturarPlan(plan, diaCorte, hoy))}`;
}

/** Líneas (HTML) de los planes con saldo por facturar de una tarjeta, para /tarjetas. */
export function lineasPlanes(planes: ReadonlyArray<PlanCuotas>, tarjeta: Cuenta, hoy: string): string[] {
  if (!tarjeta.credito) return [];
  const diaCorte = tarjeta.credito.diaCorte;
  return planes
    .filter((p) => p.tarjetaId === tarjeta.id && porFacturarPlan(p, diaCorte, hoy) > 0)
    .map((p) => `🧾 ${escapeHtml(resumenPlan(p, diaCorte, hoy))}`);
}
