/**
 * Cálculo de "libre" con IO (lo usan /libre y el guardián) y foto diaria
 * SNAP#<yyyy-mm-dd> (diseño, sección 9): base de la gráfica de "libre" del
 * dashboard. El "libre" de un día pasado no se puede reconstruir (depende de
 * lo previsto ese día), por eso se guarda. Silenciosa: no envía mensajes.
 */
import { putItemBySk } from '../dynamo';
import { daysInMonth, monthPrefixGT } from '../dates';
import { loadAdvisorData } from '../insights';
import type { AdvisorData } from '../insights';
import { proximosIngresos } from './ingresos';
import { calcularLibre } from './libre';
import type { Libre } from './libre';
import { toCents } from './money';
import { loadIngresos } from './repo';
import { loadBalancesV2 } from './saldos';
import { loadCiclos } from './tarjetas';

/** Promedio diario de los gastos del mes, en centavos (modelo v2). */
export function gastoDiarioCentavos(data: Pick<AdvisorData, 'monthTxns' | 'daysElapsed'>): number {
  const gastoMes = data.monthTxns.reduce((a, t) => a + (t.v2?.tipo === 'gasto' ? t.v2.montoCentavos : 0), 0);
  return data.daysElapsed > 0 ? Math.round(gastoMes / data.daysElapsed) : 0;
}

export async function loadLibre(today: string, advisor?: AdvisorData): Promise<{ libre: Libre; gastoDiario: number }> {
  const [{ saldos }, { tarjetas }, ingresos, data] = await Promise.all([
    loadBalancesV2(today),
    loadCiclos(today),
    loadIngresos(),
    advisor ? Promise.resolve(advisor) : loadAdvisorData(today, daysInMonth(monthPrefixGT(0))),
  ]);
  const gastoDiario = gastoDiarioCentavos(data);
  const recurrentes = data.recurrentes
    .filter((r) => r.tipo === 'gasto' && r.estado === 'confirmado')
    .map((r) => ({
      descripcion: r.descripcion,
      montoCentavos: toCents(r.montoTipico),
      dia: r.diaTipicoDePago,
      aunVieneEsteMes: r.aunVieneEsteMes,
    }));
  const libre = calcularLibre({
    hoy: today,
    saldos,
    tarjetas,
    proximos: proximosIngresos(ingresos, today),
    recurrentes,
    gastoDiarioCentavos: gastoDiario,
  });
  return { libre, gastoDiario };
}

export interface FotoDiaria {
  fecha: string;
  disponibleCentavos: number;
  deudaCentavos: number;
  /** null si no hay ingresos declarados. */
  libreCentavos: number | null;
  libreDespuesCentavos: number | null;
  proximoIngreso: string | null;
}

export const snapSk = (fecha: string): string => `SNAP#${fecha}`;

/** PURO: solo cifras agregadas, sin conceptos ni descripciones. */
export function fotoDiaria(fecha: string, libre: Libre): FotoDiaria {
  return {
    fecha,
    disponibleCentavos: libre.disponible,
    deudaCentavos: libre.deuda,
    libreCentavos: libre.libreHastaIngreso,
    libreDespuesCentavos: libre.despues?.libre ?? null,
    proximoIngreso: libre.ingreso?.fecha ?? null,
  };
}

/** Escribe (o reescribe, idempotente) la foto del día. */
export async function guardarFotoDiaria(fecha: string, libre: Libre): Promise<void> {
  await putItemBySk(snapSk(fecha), { ...fotoDiaria(fecha, libre) });
}
