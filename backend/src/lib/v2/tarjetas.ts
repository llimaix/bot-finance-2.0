/**
 * Tarjetas de crédito del modelo v2: /tarjetas y avisos del guardián
 * (diseño, secciones 5.3 y 5.4). El render y las alertas son puros; solo
 * loadCiclos hace IO.
 */
import { queryRange } from '../dynamo';
import { escapeHtml } from '../format';
import { cicloTarjeta } from './ciclos';
import type { CicloTarjeta } from './ciclos';
import type { ConfigSnapshot } from './config';
import { toMovimientos } from './legacy';
import type { Cuenta } from './model';
import { formatCents } from './money';
import { loadSnapshot } from './repo';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fecha = (iso: string): string => `${Number(iso.slice(8, 10))}-${MESES[Number(iso.slice(5, 7)) - 1]}`;
const dias = (desde: string, hasta: string): number =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

export interface TarjetaConCiclo {
  cuenta: Cuenta;
  ciclo: CicloTarjeta;
}

export async function loadCiclos(today: string): Promise<{ snap: ConfigSnapshot; tarjetas: TarjetaConCiclo[] }> {
  const snap = await loadSnapshot();
  const credito = snap.cuentas.filter((c) => c.activa && c.tipo === 'credito' && c.credito);
  if (credito.length === 0) return { snap, tarjetas: [] };
  const minAsOf = credito.reduce((min, c) => (c.asOf < min ? c.asOf : min), today);
  const movs = toMovimientos(await queryRange(minAsOf, today));
  return {
    snap,
    tarjetas: credito.map((cuenta) => ({ cuenta, ciclo: cicloTarjeta(cuenta, movs, today)! })),
  };
}

const nombre = (c: Cuenta): string =>
  `${escapeHtml(c.nombre)}${c.terminaciones.length > 0 ? ` ${c.terminaciones.map((t) => `••${t}`).join(', ')}` : ''}`;

export function renderTarjetas(tarjetas: ReadonlyArray<TarjetaConCiclo>, hoy: string): string {
  if (tarjetas.length === 0) {
    return '💳 No tienes tarjetas de crédito configuradas. Dímelas así: "agrega mi Visa BAC terminada en 1111, corta el 15, pago el 5, límite Q10,000".';
  }
  const bloques = tarjetas.map(({ cuenta, ciclo }) => {
    const limite = cuenta.credito!.limiteCentavos;
    const uso = limite > 0 ? Math.round((ciclo.deudaActual / limite) * 100) : 0;
    const faltan = dias(hoy, ciclo.fechaPago);
    const lineas = [
      `💳 <b>${nombre(cuenta)}</b>`,
      `Cortó el ${fecha(ciclo.ultimoCorte)}: ${formatCents(ciclo.deudaAlCorte)}${ciclo.aproximado ? ' (aprox.)' : ''} · pagado ${formatCents(ciclo.pagado)}`,
      ciclo.pendiente > 0
        ? faltan >= 0
          ? `Pendiente <b>${formatCents(ciclo.pendiente)}</b> · pagar antes del ${fecha(ciclo.fechaPago)} (${faltan === 0 ? 'hoy' : `en ${faltan} día${faltan === 1 ? '' : 's'}`})`
          : `⚠️ Pendiente <b>${formatCents(ciclo.pendiente)}</b> · venció el ${fecha(ciclo.fechaPago)}`
        : '✅ Pago del corte cubierto',
      ...(ciclo.pendiente > 0 && ciclo.interesEstimado !== null
        ? [`Si no pagas el total, interés estimado: ~${formatCents(ciclo.interesEstimado)}`]
        : []),
      `Periodo actual: ${formatCents(ciclo.consumoPeriodo)} · próximo corte ${fecha(ciclo.proximoCorte)}`,
      `Deuda total ${formatCents(ciclo.deudaActual)} de ${formatCents(limite)} (${uso}%)`,
    ];
    return lineas.join('\n');
  });
  return ['💳 <b>Tus tarjetas</b>', '', bloques.join('\n\n')].join('\n');
}

/** Avisos del guardián de las 08:30 (sección 5.3). Vacío si no hay nada que decir. */
export function alertasTarjetas(tarjetas: ReadonlyArray<TarjetaConCiclo>, hoy: string): string[] {
  const alertas: string[] = [];
  for (const { cuenta, ciclo } of tarjetas) {
    const n = nombre(cuenta);
    const credito = cuenta.credito!;
    if (dias(hoy, ciclo.proximoCorte) === 3) {
      alertas.push(`💳 Tu ${n} corta el ${fecha(ciclo.proximoCorte)}; llevas ${formatCents(ciclo.consumoPeriodo)} en este periodo.`);
    }
    if (dias(ciclo.ultimoCorte, hoy) === 1) {
      alertas.push(`💳 ${n} cortó en ${formatCents(ciclo.deudaAlCorte)}. Pago antes del ${fecha(ciclo.fechaPago)}.`);
    }
    const faltan = dias(hoy, ciclo.fechaPago);
    if (ciclo.pendiente > 0 && faltan >= 0 && credito.diasAviso.includes(faltan)) {
      const interes = ciclo.interesEstimado !== null ? ` Si no lo pagas completo, el interés estimado es ~${formatCents(ciclo.interesEstimado)}.` : '';
      alertas.push(
        `⏰ ${faltan === 0 ? 'Hoy vence' : `Faltan ${faltan} día${faltan === 1 ? '' : 's'} para`} el pago de ${n}: pendiente ${formatCents(ciclo.pendiente)}.${interes}`,
      );
    }
    if (ciclo.pendiente > 0 && faltan < 0) {
      alertas.push(`⚠️ Venció el pago de ${n} (${fecha(ciclo.fechaPago)}) y faltan ${formatCents(ciclo.pendiente)}.`);
    }
    if (credito.limiteCentavos > 0 && ciclo.deudaActual / credito.limiteCentavos > 0.8) {
      alertas.push(`📈 ${n} al ${Math.round((ciclo.deudaActual / credito.limiteCentavos) * 100)}% de su límite.`);
    }
  }
  return alertas;
}
