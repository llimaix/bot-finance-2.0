/**
 * Saldo por partida doble (diseño, sección 2):
 *   saldo = semilla + Σ montos con destino = cuenta − Σ montos con origen = cuenta
 * contando solo los movimientos POSTERIORES a `asOf` (la semilla es el saldo al
 * cierre de ese día). Sin casos especiales por tipo: el pago de tarjeta baja el
 * banco y baja la deuda por construcción.
 *
 * En crédito el saldo es la deuda en negativo: una compra (origen = tarjeta) lo
 * hace más negativo y un pago (destino = tarjeta) lo acerca a cero.
 */
import type { Cuenta, Movimiento } from './model';

export function saldoCentavos(cuenta: Cuenta, movimientos: ReadonlyArray<Movimiento>): number {
  let saldo = cuenta.semillaCentavos;
  for (const m of movimientos) {
    if (m.fecha <= cuenta.asOf) continue;
    if (m.destino === cuenta.id) saldo += m.montoCentavos;
    if (m.origen === cuenta.id) saldo -= m.montoCentavos;
  }
  return saldo;
}

export function saldos(cuentas: ReadonlyArray<Cuenta>, movimientos: ReadonlyArray<Movimiento>): Map<string, number> {
  return new Map(cuentas.map((c) => [c.id, saldoCentavos(c, movimientos)]));
}
