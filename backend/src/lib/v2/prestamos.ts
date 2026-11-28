/**
 * Intereses de préstamos, método mensual fijo (sistema francés):
 *   interés de la cuota = saldo de capital × tasa mensual (anual / 12)
 *   capital             = pago − interés
 *
 * Es lo que reproduce la tabla de amortización de una cuota fija. PURO (sin IO):
 * el registro lo usa para partir el pago de un préstamo en dos movimientos, el
 * capital (transferencia que baja la deuda) y el interés (gasto). Sin esto, el
 * pago completo bajaba la deuda y el saldo se alejaba del banco cada mes.
 *
 * El interés del estado de cuenta, si el usuario lo da, prevalece sobre el
 * calculado (igual que con las tarjetas: el cargo real manda).
 */
import type { Cuenta } from './model';

/** Tasa mensual como fracción (0.0233… para 28 % anual); null si el préstamo no tiene tasa. */
export function tasaMensual(cuenta: Pick<Cuenta, 'tipo' | 'prestamo'>): number | null {
  const interes = cuenta.tipo === 'prestamo' ? cuenta.prestamo?.interes : undefined;
  if (!interes) return null;
  const tasa = interes.tasaBps / 10_000;
  return interes.periodo === 'anual' ? tasa / 12 : tasa;
}

export interface PartidaPago {
  interesCentavos: number;
  capitalCentavos: number;
}

/**
 * Parte un pago entre interés y capital.
 * - `deudaCentavos`: saldo de capital antes del pago, en positivo.
 * - `interesEstadoCentavos`: interés del estado de cuenta; null = calcularlo.
 * Si el pago no alcanza para el interés, todo es interés y el capital queda en 0.
 */
export function partirPago(
  pagoCentavos: number,
  deudaCentavos: number,
  tasa: number,
  interesEstadoCentavos: number | null,
): PartidaPago {
  const calculado = Math.round(Math.max(0, deudaCentavos) * tasa);
  const interesCentavos = Math.min(pagoCentavos, Math.max(0, interesEstadoCentavos ?? calculado));
  return { interesCentavos, capitalCentavos: pagoCentavos - interesCentavos };
}
