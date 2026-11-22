/**
 * Saldos del modelo v2 (partida doble sobre los movimientos con campo `v2`).
 *
 * - loadBalancesV2: configuración + movimientos → saldo de cada cuenta.
 * - renderSaldosV2 / renderAffectedV2: cómo los ve el usuario.
 * - toLegacyBalances: forma v1 (AccountBalance) para el código que ya existe
 *   (contexto del agente, consultar_datos, guardián, proyección), que así pasa
 *   a v2 sin reescribirse.
 */
import type { AccountBalance } from '../accounts';
import { queryRange } from '../dynamo';
import { escapeHtml } from '../format';
import type { AccountId, Transaction } from '../types';
import { saldoCentavos } from './balance';
import type { ConfigSnapshot } from './config';
import { toMovimientos } from './legacy';
import type { Cuenta } from './model';
import { formatCents, fromCents } from './money';
import { loadSnapshot } from './repo';

export interface SaldoV2 {
  cuenta: Cuenta;
  saldoCentavos: number;
  /** Movimientos posteriores a la semilla que tocaron la cuenta. */
  movimientos: number;
}

const EMOJI: Record<Cuenta['tipo'], string> = { banco: '🏦', credito: '💳', efectivo: '💵', billetera: '📱' };

/** Cálculo puro: saldo de cada cuenta a partir de las transacciones guardadas. */
export function computeSaldosV2(snap: ConfigSnapshot, txns: ReadonlyArray<Transaction>): SaldoV2[] {
  const movs = toMovimientos(txns);
  return snap.cuentas.map((cuenta) => ({
    cuenta,
    saldoCentavos: saldoCentavos(cuenta, movs),
    movimientos: movs.filter(
      (m) => m.fecha > cuenta.asOf && (m.origen === cuenta.id || m.destino === cuenta.id),
    ).length,
  }));
}

export async function loadBalancesV2(today: string): Promise<{ snap: ConfigSnapshot; saldos: SaldoV2[] }> {
  const snap = await loadSnapshot();
  if (snap.cuentas.length === 0) return { snap, saldos: [] };
  const minAsOf = snap.cuentas.reduce((min, c) => (c.asOf < min ? c.asOf : min), today);
  const txns = await queryRange(minAsOf, today);
  return { snap, saldos: computeSaldosV2(snap, txns) };
}

function lineaCuenta(s: SaldoV2): string {
  const c = s.cuenta;
  const terms = c.terminaciones.length > 0 ? ` ${c.terminaciones.map((t) => `••${t}`).join(', ')}` : '';
  const estimado = c.estimada && s.movimientos === 0 ? ' <i>(sin saldo inicial)</i>' : '';
  const nombre = `${EMOJI[c.tipo]} ${escapeHtml(c.nombre)}${terms}`;
  if (c.tipo === 'credito' && c.credito) {
    const deuda = Math.max(0, -s.saldoCentavos);
    const disponible = c.credito.limiteCentavos - deuda;
    const uso = c.credito.limiteCentavos > 0 ? Math.round((deuda / c.credito.limiteCentavos) * 100) : 0;
    return `${nombre}: debes <b>${formatCents(deuda)}</b> · disponible ${formatCents(disponible)} (${uso}% del límite)${estimado}`;
  }
  return `${nombre}: <b>${formatCents(s.saldoCentavos)}</b>${estimado}`;
}

export function renderSaldosV2(saldos: ReadonlyArray<SaldoV2>): string {
  const activos = saldos.filter((s) => s.cuenta.activa);
  if (activos.length === 0) {
    return '💰 Aún no hay cuentas en el modelo nuevo. Dímelas en lenguaje natural, por ejemplo: "agrega mi BI débito terminada en 2222, tengo Q4,000".';
  }
  const disponible = activos.filter((s) => s.cuenta.tipo !== 'credito').reduce((a, s) => a + s.saldoCentavos, 0);
  const deuda = activos.filter((s) => s.cuenta.tipo === 'credito').reduce((a, s) => a + Math.max(0, -s.saldoCentavos), 0);
  return [
    '💰 <b>Tus saldos</b>',
    '',
    ...activos.map(lineaCuenta),
    '',
    `💵 Disponible: <b>${formatCents(disponible)}</b>`,
    `💳 Deuda total: <b>${formatCents(deuda)}</b>`,
    `🧮 Neto: ${formatCents(disponible - deuda)}`,
    '',
    'Ajusta un saldo diciéndomelo, por ejemplo: "mi BI débito tiene Q4,000".',
  ].join('\n');
}

/** Una línea por cada cuenta que tocaron los movimientos recién registrados. */
export function renderAffectedV2(txns: ReadonlyArray<Transaction>, saldos: ReadonlyArray<SaldoV2>): string[] {
  const tocadas = new Set(txns.flatMap((t) => (t.v2 ? [t.v2.origen, t.v2.destino] : [])).filter(Boolean));
  return saldos.filter((s) => tocadas.has(s.cuenta.id)).map(lineaCuenta);
}

/**
 * Forma v1 para el código existente. El id de v2 no pertenece a la unión
 * AccountId de v1: el cast es intencional y solo se usa como etiqueta.
 * En crédito el saldo queda negativo (deuda), igual que la tarjeta de v1, así
 * que el "neto líquido" de insights sigue siendo correcto.
 */
export function toLegacyBalances(saldos: ReadonlyArray<SaldoV2>): AccountBalance[] {
  return saldos
    .filter((s) => s.cuenta.activa)
    .map((s) => ({
      id: s.cuenta.id as AccountId,
      name: s.cuenta.nombre,
      emoji: EMOJI[s.cuenta.tipo],
      seedBalance: fromCents(s.cuenta.semillaCentavos),
      asOf: s.cuenta.asOf,
      estimated: s.cuenta.estimada,
      updatedAt: '',
      balance: fromCents(s.saldoCentavos),
      movements: s.movimientos,
    }));
}

