/**
 * Puente entre el modelo v2 (origen/destino en centavos) y los campos v1 que
 * siguen usando reportes, agregados, metas, recurrentes y búsqueda.
 *
 * Un movimiento v2 se guarda en el mismo item TXN# con:
 *   - `v2`: la verdad (partida doble en centavos), y
 *   - amount/type/method: derivados de `v2`, solo para que el código v1 que
 *     agrupa por categoría, tipo o método siga funcionando sin reescribirlo.
 * Los saldos del modelo nuevo se calculan SIEMPRE desde `v2`, nunca desde los
 * campos derivados.
 */
import type { Method, Transaction, TransactionV2, TxnType } from '../types';
import type { Cuenta, Movimiento } from './model';
import { fromCents } from './money';

type TipoCuenta = Cuenta['tipo'];

/** Método v1 equivalente a pagar o cobrar con una cuenta de ese tipo. */
function metodoDe(tipo: TipoCuenta | undefined): Method {
  switch (tipo) {
    case 'credito':
      return 'credito';
    case 'banco':
      return 'debito';
    case 'efectivo':
      return 'efectivo';
    case 'billetera':
      return 'transferencia';
    default:
      return 'na';
  }
}

/** Campos v1 (amount, type, method) derivados de un movimiento v2. */
export function legacyFields(
  v2: TransactionV2,
  cuentas: ReadonlyArray<Cuenta>,
): { amount: number; type: TxnType; method: Method } {
  const tipoDe = (id: string | null) => (id ? cuentas.find((c) => c.id === id)?.tipo : undefined);
  const origen = tipoDe(v2.origen);
  const destino = tipoDe(v2.destino);
  const amount = fromCents(v2.montoCentavos);

  if (v2.tipo === 'gasto') return { amount, type: 'gasto', method: metodoDe(origen) };
  if (v2.tipo === 'ingreso') return { amount, type: 'ingreso', method: metodoDe(destino) };

  // Transferencias entre cuentas propias: v1 distinguía retiro y depósito.
  if (destino === 'efectivo' && origen !== 'efectivo') return { amount, type: 'retiro', method: metodoDe(origen) };
  if (origen === 'efectivo' && destino !== 'efectivo') return { amount, type: 'deposito', method: 'efectivo' };
  return { amount, type: 'transferencia', method: metodoDe(origen) };
}

/** Movimiento v2 a partir de una transacción guardada; null si es de v1. */
export function toMovimiento(txn: Transaction): Movimiento | null {
  if (!txn.v2) return null;
  return {
    fecha: txn.date,
    montoCentavos: txn.v2.montoCentavos,
    tipo: txn.v2.tipo,
    origen: txn.v2.origen,
    destino: txn.v2.destino,
    categoria: txn.category,
    descripcion: txn.description,
    cuentaFuente: txn.v2.cuentaFuente,
  };
}

/** Movimientos v2 de una lista de transacciones (ignora las de v1). */
export function toMovimientos(txns: ReadonlyArray<Transaction>): Movimiento[] {
  return txns.map(toMovimiento).filter((m): m is Movimiento => m !== null);
}
