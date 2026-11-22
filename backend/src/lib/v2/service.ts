/**
 * Servicio de configuración v2: planear (puro) → guardar con deshacer → resumen.
 * Lo usan las herramientas del agente y el comando /cuentas.
 */
import { toPlainText } from '../telegram';
import {
  planCrearCuenta,
  planEditarCuenta,
  planEntidad,
  resumenCuenta,
  resumenEntidad,
} from './config';
import type { ConfigSnapshot, CrearCuentaInput, EditarCuentaInput, EntidadInput } from './config';
import { cuentaWrite, entidadWrite, loadSnapshot, saveWithUndo } from './repo';

export type ServiceResult =
  | { ok: true; html: string; texto: string; undoId: string }
  | { ok: false; errors: string[] };

const NOTA_V2 =
  '<i>Es configuración del modelo nuevo de cuentas: se usará al activarlo. Hoy /saldo y los movimientos siguen con las cuentas actuales.</i>';

const done = (html: string, undoId: string): ServiceResult => ({ ok: true, html, texto: toPlainText(html), undoId });

export async function crearCuenta(input: CrearCuentaInput, today: string): Promise<ServiceResult> {
  const snap = await loadSnapshot();
  const plan = planCrearCuenta(input, snap, today);
  if (!plan.ok) return plan;

  const { cuenta, entidadNueva } = plan.value;
  const undoId = await saveWithUndo([
    ...(entidadNueva ? [entidadWrite(entidadNueva, null)] : []),
    cuentaWrite(cuenta, null),
  ]);
  const entidades = entidadNueva ? [...snap.entidades, entidadNueva] : snap.entidades;
  const html = [
    '✅ <b>Cuenta guardada</b>',
    '',
    resumenCuenta(cuenta, entidades),
    ...(entidadNueva ? ['', 'También registré el banco:', resumenEntidad(entidadNueva)] : []),
    '',
    NOTA_V2,
  ].join('\n');
  return done(html, undoId);
}

export async function editarCuenta(input: EditarCuentaInput, today: string): Promise<ServiceResult> {
  const snap = await loadSnapshot();
  const plan = planEditarCuenta(input, snap, today);
  if (!plan.ok) return plan;

  const { antes, despues } = plan.value;
  const undoId = await saveWithUndo([cuentaWrite(despues, antes)]);
  const html = ['✅ <b>Cuenta actualizada</b>', '', resumenCuenta(despues, snap.entidades), '', NOTA_V2].join('\n');
  return done(html, undoId);
}

export async function gestionarEntidad(input: EntidadInput): Promise<ServiceResult> {
  const snap = await loadSnapshot();
  const plan = planEntidad(input, snap);
  if (!plan.ok) return plan;

  const { antes, despues } = plan.value;
  const undoId = await saveWithUndo([entidadWrite(despues, antes)]);
  const html = [antes ? '✅ <b>Banco actualizado</b>' : '✅ <b>Banco guardado</b>', '', resumenEntidad(despues)].join('\n');
  return done(html, undoId);
}

/** Listado para /cuentas. */
export function renderConfig(snap: ConfigSnapshot): string {
  if (snap.cuentas.length === 0 && snap.entidades.length === 0) {
    return [
      '🏦 Aún no hay cuentas en el modelo nuevo.',
      '',
      'Dímelas en lenguaje natural, por ejemplo: "agrega mi Visa BAC terminada en 1111, corta el 15, pago el 5, límite Q10,000".',
    ].join('\n');
  }
  const activas = [...snap.cuentas].sort((a, b) => Number(b.activa) - Number(a.activa) || a.nombre.localeCompare(b.nombre));
  return [
    '🏦 <b>Cuentas (modelo nuevo)</b>',
    '',
    ...activas.map((c) => resumenCuenta(c, snap.entidades)).join('\n\n').split('\n'),
    ...(snap.entidades.length > 0 ? ['', '<b>Bancos</b>', ...snap.entidades.map(resumenEntidad)] : []),
  ].join('\n');
}

export { loadSnapshot };
