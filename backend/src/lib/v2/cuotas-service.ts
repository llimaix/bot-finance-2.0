/**
 * Compras a cuotas (IO): registrar, cancelar y cargar las cuotas que vencen.
 *
 * - crearCompraCuotas: guarda el plan y carga de una vez las cuotas cuyo corte
 *   ya pasó (compra registrada tarde). Todo con ↩️ Deshacer.
 * - cancelarCompraCuotas: deja de cargar cuotas; si se liquidó antes, carga a
 *   la tarjeta lo que faltaba facturar.
 * - generarCuotasPendientes: lo corre el guardián cada día. Cada cuota tiene un
 *   SK determinista, así que correrlo dos veces no la duplica y un día perdido
 *   se recupera al siguiente.
 */
import { getItemBySk, listCategories, putItemBySk, reserveShortIds } from '../dynamo';
import { escapeHtml } from '../format';
import { logger } from '../logger';
import { toPlainText } from '../telegram';
import type { Transaction, TransactionV2 } from '../types';
import type { ConfigSnapshot } from './config';
import {
  calendarioCuotas,
  cuotaSk,
  cuotasVencidas,
  findPlan,
  montoCuota,
  movimientoCuota,
  planCompraCuotas,
  porFacturarPlan,
  restoSk,
} from './cuotas';
import type { CompraCuotasInput, PlanCuotas } from './cuotas';
import { legacyFields } from './legacy';
import { formatCents } from './money';
import { loadPlanesCuotas, loadSnapshot, planSk, planWrite, saveWithUndo, txnWrite } from './repo';
import type { ServiceResult } from './service';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fecha = (iso: string): string => `${Number(iso.slice(8, 10))}-${MESES[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;

interface CargoNuevo {
  sk: string;
  date: string;
  category: string;
  description: string;
  v2: TransactionV2;
}

/** Arma los movimientos con su shortId del día (sin marcar el día como reportado). */
async function materializar(cargos: ReadonlyArray<CargoNuevo>, snap: ConfigSnapshot, rawMessage: string): Promise<Transaction[]> {
  const createdAt = new Date().toISOString();
  const porFecha = new Map<string, CargoNuevo[]>();
  for (const c of cargos) porFecha.set(c.date, [...(porFecha.get(c.date) ?? []), c]);
  const txns: Transaction[] = [];
  for (const [date, grupo] of porFecha) {
    const ids = await reserveShortIds(date, grupo.length);
    grupo.forEach((c, i) => {
      txns.push({
        sk: c.sk,
        date,
        shortId: ids[i]!,
        rawMessage,
        createdAt,
        category: c.category,
        description: c.description,
        ...legacyFields(c.v2, snap.cuentas),
        v2: c.v2,
      });
    });
  }
  return txns;
}

const cargoCuota = (plan: PlanCuotas, cuota: ReturnType<typeof calendarioCuotas>[number]): CargoNuevo => ({
  sk: cuotaSk(plan.id, cuota),
  ...movimientoCuota(plan, cuota),
});

const done = (html: string, undoId: string): ServiceResult => ({ ok: true, html, texto: toPlainText(html), undoId });

export async function crearCompraCuotas(input: CompraCuotasInput, today: string): Promise<ServiceResult> {
  const [snap, planes, categorias] = await Promise.all([loadSnapshot(), loadPlanesCuotas(), listCategories()]);
  const plan = planCompraCuotas(input, snap, planes, categorias.map((c) => c.name), today);
  if (!plan.ok) return plan;

  const p = plan.value;
  const tarjeta = snap.cuentas.find((c) => c.id === p.tarjetaId)!;
  const diaCorte = tarjeta.credito!.diaCorte;
  const calendario = calendarioCuotas(p, diaCorte);
  const vencidas = cuotasVencidas(p, diaCorte, today);
  const txns = await materializar(vencidas.map((c) => cargoCuota(p, c)), snap, `Compra a cuotas: ${p.descripcion}`);
  const undoId = await saveWithUndo([planWrite(p, null), ...txns.map(txnWrite)]);

  const html = [
    '✅ <b>Compra a cuotas guardada</b>',
    '',
    `🧾 <b>${escapeHtml(p.descripcion)}</b> en ${escapeHtml(tarjeta.nombre)}`,
    `Total ${formatCents(p.montoCentavos)} en ${p.cuotas} cuotas de ${formatCents(montoCuota(p, 1))} sin intereses`,
    `Primera cuota en el corte del ${fecha(calendario[0]!.fecha)}; última en el del ${fecha(calendario[calendario.length - 1]!.fecha)}`,
    ...(vencidas.length > 0 ? [`Ya cargué ${vencidas.length} cuota${vencidas.length === 1 ? '' : 's'} de cortes que ya pasaron.`] : []),
    `Por facturar: ${formatCents(porFacturarPlan(p, diaCorte, today))} (se resta del disponible de la tarjeta)`,
  ].join('\n');
  return done(html, undoId);
}

export interface CancelarCuotasInput {
  /** Descripción o id del plan. */
  compra: string;
  /** true = se liquidó antes: cargar hoy a la tarjeta lo que faltaba facturar. */
  cargarResto: boolean;
}

export async function cancelarCompraCuotas(input: CancelarCuotasInput, today: string): Promise<ServiceResult> {
  const [snap, planes] = await Promise.all([loadSnapshot(), loadPlanesCuotas()]);
  const plan = findPlan(input.compra, planes);
  if (!plan) {
    const activos = planes.filter((p) => p.activo).map((p) => p.descripcion);
    return {
      ok: false,
      errors: [`No encontré la compra a cuotas "${input.compra}". ${activos.length > 0 ? `Activas: ${activos.join(', ')}.` : 'No hay compras a cuotas activas.'}`],
    };
  }
  const tarjeta = snap.cuentas.find((c) => c.id === plan.tarjetaId);
  const resto = tarjeta?.credito ? porFacturarPlan(plan, tarjeta.credito.diaCorte, today) : 0;
  const cargos: CargoNuevo[] =
    input.cargarResto && resto > 0
      ? [
          {
            sk: restoSk(plan.id, today),
            date: today,
            category: plan.categoria,
            description: `${plan.descripcion} (saldo de cuotas liquidado)`,
            v2: { montoCentavos: resto, tipo: 'gasto', origen: plan.tarjetaId, destino: null, cuentaFuente: 'usuario' },
          },
        ]
      : [];
  const txns = await materializar(cargos, snap, `Cancelar compra a cuotas: ${plan.descripcion}`);
  const undoId = await saveWithUndo([planWrite({ ...plan, activo: false }, plan), ...txns.map(txnWrite)]);

  const html = [
    '✅ <b>Compra a cuotas cerrada</b>',
    '',
    `🧾 ${escapeHtml(plan.descripcion)}: ya no se cargarán más cuotas.`,
    txns.length > 0
      ? `Cargué hoy a ${escapeHtml(tarjeta?.nombre ?? plan.tarjetaId)} lo que faltaba: ${formatCents(resto)}.`
      : resto > 0
        ? `Quedaron sin cargar ${formatCents(resto)}.`
        : 'No quedaba nada por facturar.',
  ].join('\n');
  return done(html, undoId);
}

/**
 * Carga las cuotas cuyo corte ya llegó y aún no existen. Un plan cuya última
 * cuota ya está cargada se cierra para no revisarlo cada día. Devuelve cuántas cargó.
 */
export async function generarCuotasPendientes(today: string): Promise<number> {
  const planes = (await loadPlanesCuotas()).filter((p) => p.activo);
  if (planes.length === 0) return 0;
  const snap = await loadSnapshot();

  const cargos: CargoNuevo[] = [];
  const terminados: PlanCuotas[] = [];
  for (const plan of planes) {
    const tarjeta = snap.cuentas.find((c) => c.id === plan.tarjetaId);
    if (!tarjeta?.credito) {
      logger.error('plan de cuotas sin tarjeta de crédito', { plan: plan.id, tarjeta: plan.tarjetaId });
      continue;
    }
    const vencidas = cuotasVencidas(plan, tarjeta.credito.diaCorte, today);
    for (const cuota of vencidas) {
      const cargo = cargoCuota(plan, cuota);
      if (!(await getItemBySk(cargo.sk))) cargos.push(cargo);
    }
    if (vencidas.length === plan.cuotas) terminados.push(plan);
  }

  const txns = await materializar(cargos, snap, 'Cuota automática de compra a cuotas');
  for (const txn of txns) {
    const { sk, ...rest } = txn;
    await putItemBySk(sk, rest);
  }
  for (const plan of terminados) await putItemBySk(planSk(plan.id), { ...plan, activo: false });
  if (txns.length > 0 || terminados.length > 0) {
    logger.info('cuotas cargadas', { cuotas: txns.length, planesTerminados: terminados.length });
  }
  return txns.length;
}
