/**
 * Registro de movimientos en el modelo v2: decide origen/destino y valida.
 * PURO (sin IO): recibe lo que propuso el modelo, el texto del usuario y la
 * configuración de cuentas, y devuelve los movimientos listos para guardar o
 * los problemas para que el agente pregunte. Si algo no cuadra, NO se guarda
 * nada: mejor una pregunta que un saldo equivocado.
 */
import type { Method, TransactionV2, TxnType } from '../types';
import type { ConfigSnapshot } from './config';
import { legacyFields } from './legacy';
import { validateMovimiento } from './model';
import { formatCents, toCents } from './money';
import { partirPago, tasaMensual } from './prestamos';
import { resolverCuenta } from './resolver';

/** Lo mínimo de un movimiento ya materializado (monto en Q, fecha resuelta). */
export interface PropuestaV2 {
  amount: number;
  type: TxnType;
  category: string;
  description: string;
  date: string;
  /** Lo que propuso el modelo (ids de cuentas v2) o null. */
  origen?: string | null;
  destino?: string | null;
  /** Solo pagos de préstamo: interés en Q del estado de cuenta; null = lo calcula el sistema. */
  interes?: number | null;
}

/** Movimiento listo para guardar: sin la propuesta cruda del modelo, con v2 y los campos v1 derivados. */
export type MovimientoV2Listo<T> = Omit<T, 'origen' | 'destino' | 'interes'> & { amount: number; type: TxnType; method: Method; v2: TransactionV2 };

export type RegistroV2<T> =
  | { ok: true; txns: Array<MovimientoV2Listo<T>>; avisos: string[] }
  | { ok: false; errores: string[] };

const tipoV2 = (type: TxnType): TransactionV2['tipo'] =>
  type === 'gasto' ? 'gasto' : type === 'ingreso' ? 'ingreso' : 'transferencia';

export function planRegistroV2<T extends PropuestaV2>(
  propuestas: ReadonlyArray<T>,
  userText: string,
  snap: ConfigSnapshot,
  terminacionImagen: string | null = null,
  /** Deuda actual (centavos, en positivo) de cada préstamo, para partir sus pagos en capital e interés. */
  deudas: ReadonlyMap<string, number> = new Map(),
): RegistroV2<T> {
  if (snap.cuentas.filter((c) => c.activa).length === 0) {
    return {
      ok: false,
      errores: ['No hay cuentas configuradas en el modelo nuevo. Pide al usuario sus cuentas y créalas con crear_cuenta antes de registrar.'],
    };
  }

  // El resolvedor solo se impone con UN movimiento: con varios, cada uno puede
  // ir a una cuenta distinta y la pista del texto no dice a cuál aplica.
  const resolucion = propuestas.length === 1 ? resolverCuenta(userText, snap, terminacionImagen) : null;
  const nombre = (id: string) => snap.cuentas.find((c) => c.id === id)?.nombre ?? id;

  const errores: string[] = [];
  const avisos: string[] = [];
  const txns: Array<MovimientoV2Listo<T>> = [];
  // Deuda que queda tras cada pago: dos cuotas en el mismo mensaje no se calculan sobre el mismo saldo.
  const deudaRestante = new Map(deudas);

  for (const [i, p] of propuestas.entries()) {
    const tipo = tipoV2(p.type);
    let origen = p.origen ?? null;
    let destino = p.destino ?? null;
    let cuentaFuente: TransactionV2['cuentaFuente'] = 'modelo';
    const etiqueta = propuestas.length > 1 ? `Movimiento ${i + 1} (${p.description || p.category}): ` : '';

    if (resolucion?.tipo === 'terminacion_desconocida') {
      errores.push(
        `${etiqueta}la terminación ••${resolucion.terminacion} no está en ninguna cuenta. Pregunta al usuario de qué cuenta es, agrégala con editar_cuenta (agregarTerminaciones) y vuelve a registrar.`,
      );
      continue;
    }
    if (resolucion?.tipo === 'cuenta' && tipo !== 'transferencia') {
      // El código manda sobre la propuesta del modelo.
      if (tipo === 'gasto') origen = resolucion.cuentaId;
      else destino = resolucion.cuentaId;
      cuentaFuente = resolucion.fuente;
    }

    const falta = tipo === 'gasto' ? origen === null : tipo === 'ingreso' ? destino === null : origen === null || destino === null;
    if (falta) {
      const opciones =
        resolucion?.tipo === 'ambigua'
          ? ` Puede ser: ${resolucion.candidatas.map(nombre).join(' o ')}.`
          : '';
      errores.push(`${etiqueta}no sé de qué cuenta ${tipo === 'ingreso' ? 'entra' : 'sale'} el dinero. Pregúntaselo al usuario.${opciones}`);
      continue;
    }

    const v2: TransactionV2 = { montoCentavos: toCents(p.amount), tipo, origen, destino, cuentaFuente };
    const v = validateMovimiento(
      { ...v2, fecha: p.date, categoria: p.category, descripcion: p.description },
      snap.cuentas,
    );
    if (v.errors.length > 0) {
      errores.push(...v.errors.map((e) => `${etiqueta}${e}`));
      continue;
    }
    // origen/destino viven en v2: no se guardan sueltos en el item.
    const { origen: _origen, destino: _destino, interes: _interes, ...resto } = p;

    // Pago a un préstamo con tasa: el CÓDIGO lo parte en interés (gasto) y
    // capital (transferencia). Solo el capital baja la deuda.
    const prestamo = tipo === 'transferencia' ? snap.cuentas.find((c) => c.id === destino) : undefined;
    const tasa = prestamo ? tasaMensual(prestamo) : null;
    if (prestamo && tasa !== null) {
      const deuda = deudaRestante.get(prestamo.id) ?? 0;
      const interesEstado = p.interes != null ? toCents(p.interes) : null;
      const { interesCentavos, capitalCentavos } = partirPago(v2.montoCentavos, deuda, tasa, interesEstado);
      deudaRestante.set(prestamo.id, deuda - capitalCentavos);
      if (interesCentavos > 0) {
        const v2Interes: TransactionV2 = { montoCentavos: interesCentavos, tipo: 'gasto', origen, destino: null, cuentaFuente };
        txns.push({
          ...resto,
          category: 'deuda',
          description: `Intereses ${prestamo.nombre}`,
          ...legacyFields(v2Interes, snap.cuentas),
          v2: v2Interes,
        });
      }
      if (capitalCentavos > 0) {
        const v2Capital: TransactionV2 = { ...v2, montoCentavos: capitalCentavos };
        txns.push({
          ...resto,
          description: `Capital ${prestamo.nombre}`,
          ...legacyFields(v2Capital, snap.cuentas),
          v2: v2Capital,
        });
      } else {
        avisos.push(
          `El pago de ${formatCents(v2.montoCentavos)} a ${prestamo.nombre} no cubre los intereses del mes: todo se fue a intereses y la deuda no bajó.`,
        );
      }
      continue;
    }

    txns.push({ ...resto, ...legacyFields(v2, snap.cuentas), v2 });
  }

  return errores.length > 0 ? { ok: false, errores } : { ok: true, txns, avisos };
}
