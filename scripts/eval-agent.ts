/**
 * Set de evaluación GOLDEN del agente — casos reales salidos de los diálogos
 * de Allan (incluidos los que fallaron en producción). Corre contra el modelo
 * real con dependencias simuladas en memoria y valida qué herramientas llama.
 *
 * Uso:  ANTHROPIC_API_KEY=sk-... pnpm tsx scripts/eval-agent.ts [filtro] [--times N]
 * (correrlo antes de deployar cambios de prompts/herramientas; el filtro corre
 * solo los casos cuyo nombre lo contenga, N veces — para medir estabilidad)
 */
import { runAgent } from '../src/lib/ai/agent';
import type { AgentDeps } from '../src/lib/ai/agent';
import type { Transaction } from '../src/lib/types';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Falta ANTHROPIC_API_KEY en el entorno.');
  process.exit(1);
}

interface GoldenCase {
  name: string;
  user: string;
  /** Herramientas que DEBE llamar. */
  expectTools: string[];
  /** Herramientas que NO debe llamar. */
  forbidTools?: string[];
}

const CASES: GoldenCase[] = [
  { name: 'saludo no registra', user: 'Hola, ¿cómo estás?', expectTools: [], forbidTools: ['registrar_movimientos', 'dia_sin_movimientos'] },
  { name: 'gasto simple', user: 'gasté Q45 en almuerzo en efectivo', expectTools: ['registrar_movimientos'] },
  { name: 'retroactivo', user: 'ayer gasté Q80 de gasolina con la de débito', expectTools: ['registrar_movimientos'] },
  { name: 'día sin movimientos', user: 'hoy nada', expectTools: ['dia_sin_movimientos'], forbidTools: ['registrar_movimientos'] },
  { name: 'pregunta de saldo', user: '¿Cuánto dinero tengo ahora?', expectTools: ['consultar_datos'], forbidTools: ['registrar_movimientos'] },
  { name: 'corrección de cuenta (incidente Banrural)', user: 'en banrural solo tengo 40 quetzales', expectTools: ['ajustar_cuenta'], forbidTools: ['registrar_movimientos'] },
  { name: 'hecho durable', user: 'mi salario cae el 15 y el 29 de cada mes, recordalo', expectTools: ['recordar_dato'] },
  { name: 'pregunta histórica', user: '¿cuánto gasté en farmacias en mayo?', expectTools: ['buscar_movimientos'] },
  { name: 'editar método (incidente débito)', user: 'los pagos 4, 5 y 6 de hoy fueron con débito y no crédito, ajustalos', expectTools: ['corregir_movimiento'], forbidTools: ['registrar_movimientos'] },
  { name: 'borrar movimiento', user: 'borra el movimiento 3 de hoy', expectTools: ['eliminar_movimiento'] },
  { name: 'veredicto de compra', user: 'me quiero comprar la play 5, ¿me alcanza?', expectTools: ['consultar_datos'], forbidTools: ['registrar_movimientos'] },
  // Incidente 11-jul: reconciliar NO es registrar. El usuario re-explica para qué
  // fueron los dos retiros que YA están registrados (ver contexto); el agente debe
  // consultar/responder, NUNCA crear "préstamo" ni "salida" como gastos nuevos.
  {
    name: 'reconciliación no duplica (incidente 11-jul)',
    user: 'Pongámonos en orden con lo de ayer: esos dos retiros de mil que ya tenés anotados, uno fue para prestarle a mamá y el otro para la salida con amigos. Solo quiero cuadrar, ¿cómo me quedó el efectivo?',
    expectTools: ['consultar_datos'],
    forbidTools: ['registrar_movimientos'],
  },
  {
    name: 'meta de gasto por chat',
    user: 'ponme una meta de 1500 al mes en comida',
    expectTools: ['fijar_meta'],
    forbidTools: ['registrar_movimientos', 'recordar_dato'],
  },
];

const fakeTxn = (shortId: number): Transaction => ({
  sk: `TXN#2026-07-12#eval${shortId}`,
  date: '2026-07-12',
  shortId,
  amount: 45,
  type: 'gasto',
  category: 'comida',
  method: 'efectivo',
  description: 'almuerzo',
  rawMessage: 'eval',
  createdAt: '2026-07-12T12:00:00Z',
  emoji: '🍽️',
});

const SNAPSHOT = {
  fecha: '2026-07-12',
  saldos: [
    { cuenta: 'Banco Industrial (BI)', id: 'banco', saldo: 2101.01, alCorteDe: '2026-07-10', estimado: false },
    { cuenta: 'Banrural', id: 'banrural', saldo: 40, alCorteDe: '2026-07-11', estimado: false },
    { cuenta: 'Tarjeta BAC', id: 'tarjeta', saldo: -4246.37, alCorteDe: '2026-07-10', estimado: false },
    { cuenta: 'Efectivo', id: 'efectivo', saldo: 700, alCorteDe: '2026-07-12', estimado: true },
    { cuenta: 'Kash', id: 'kash', saldo: 0, alCorteDe: '2026-07-10', estimado: true },
  ],
  netoLiquido: -1405.36,
  recurrentes: [
    { descripcion: 'Salario 1ra quincena', categoria: 'otros', tipo: 'ingreso', montoTipico: 7500, diaTipicoDePago: 15, estado: 'confirmado', yaPagadoEsteMes: false, aunVieneEsteMes: true },
    { descripcion: 'Universidad Mariano Gálvez', categoria: 'educacion', tipo: 'gasto', montoTipico: 1840, diaTipicoDePago: 6, estado: 'confirmado', yaPagadoEsteMes: false, aunVieneEsteMes: false },
  ],
  proyeccionFinDeMes: {
    diasRestantes: 19,
    ingresosEsperadosRestantes: 13784,
    compromisosPendientes: 169.54,
    gastoVariableDiario: 641,
    gastoVariableProyectado: 12179,
    disponibleProyectadoFinDeMes: 30.1,
  },
  mesActual: { periodo: 'julio (al día 12)', totalGastos: 8267.44, totalIngresos: 10143.15 },
};

function buildDeps(called: string[]): AgentDeps {
  const track = <T>(name: string, value: T): T => {
    called.push(name);
    return value;
  };
  return {
    today: '2026-07-12',
    contextInfo: [
      'Cuentas (saldo actual): Banco Industrial (BI) [id:banco]: Q2,101.01; Banrural [id:banrural]: Q40.00; Tarjeta BAC [id:tarjeta]: Q-4,246.37; Efectivo [id:efectivo]: Q700.00 (estimado); Kash [id:kash]: Q0.00 (estimado).',
      'Catálogo de categorías: comida, supermercado, transporte, hogar, salud, educacion, entretenimiento, servicios, suscripciones, ahorro, deuda, tecnologia, viajes, otros.',
      'Hechos que Allan te ha enseñado:\n- Energuate es su pago de energía eléctrica (categoría servicios).',
      [
        'Movimientos ya registrados (ayer y hoy) — NO los vuelvas a registrar; si algo aquí hay que cambiar, usa corregir_movimiento/eliminar_movimiento con su número y fecha:',
        '- #1 2026-07-11 Q1,000.00 debito retiro · Retiro de cajero para gastos de préstamos',
        '- #2 2026-07-11 Q1,000.00 debito retiro · Retiro para salida con amigos',
        '- #1 2026-07-12 Q120.00 efectivo gasto · Cena con novia',
        '- #2 2026-07-12 Q78.51 credito gasto · SAT2000',
        '- #3 2026-07-12 Q75.00 credito gasto · SAT2000',
        '- #4 2026-07-12 Q153.00 credito gasto · Neonet Guatemala',
        '- #5 2026-07-12 Q195.00 credito gasto · Claro',
        '- #6 2026-07-12 Q329.00 credito gasto · Internet residencial',
      ].join('\n'),
    ].join('\n'),
    register: async (input) =>
      track('registrar_movimientos', {
        txns: input.transactions.map((_, i) => fakeTxn(7 + i)),
        createdCategories: [],
        totalSpentToday: 145,
        advertencias: [],
      }),
    snapshot: async () => track('consultar_datos', SNAPSHOT),
    adjustAccount: async (input) => track('ajustar_cuenta', { ok: true, cuenta: input.cuenta, saldoAlCierreDeHoy: input.nuevoSaldo }),
    markNoMovements: async () => {
      track('dia_sin_movimientos', undefined);
    },
    rememberFact: async (dato) => track('recordar_dato', { ok: true, aprendido: dato }),
    correctMovement: async ({ numero }) =>
      track('corregir_movimiento', { ok: true, antes: { metodo: 'credito' }, ahora: { metodo: 'debito' }, numero }),
    deleteMovement: async ({ numero }) => track('eliminar_movimiento', { ok: true, eliminado: { numero } }),
    setBudget: async ({ categoria, topeMensual }) =>
      track('fijar_meta', { ok: true, meta: { categoria, topeMensual } }),
    searchMovements: async () =>
      track('buscar_movimientos', {
        rango: { desde: '2026-05-01', hasta: '2026-05-31' },
        encontrados: 3,
        porTipo: { gasto: { total: 912.66, count: 3 } },
        gastosPorCategoria: { salud: 912.66 },
        movimientos: [
          { fecha: '2026-05-11', monto: 551, tipo: 'gasto', categoria: 'salud', metodo: 'credito', descripcion: 'Farmacia Cruz Verde' },
          { fecha: '2026-05-25', monto: 165, tipo: 'gasto', categoria: 'salud', metodo: 'debito', descripcion: 'Farmacia Arroyo' },
          { fecha: '2026-06-04', monto: 196.66, tipo: 'gasto', categoria: 'salud', metodo: 'credito', descripcion: 'Farmacias Galeno' },
        ],
      }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const timesIdx = args.indexOf('--times');
  const times = timesIdx >= 0 ? Number.parseInt(args[timesIdx + 1] ?? '1', 10) : 1;
  const filter = args.filter((a, i) => a !== '--times' && i !== timesIdx + 1)[0];

  const selected = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES;
  const runs = Array.from({ length: Math.max(1, times) }, () => selected).flat();

  let failures = 0;
  for (const c of runs) {
    const called: string[] = [];
    let reply = '';
    let error: string | null = null;
    try {
      const result = await runAgent(c.user, [], buildDeps(called), { timeoutMs: 45_000 });
      reply = result.text;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const missing = c.expectTools.filter((t) => !called.includes(t));
    const forbidden = (c.forbidTools ?? []).filter((t) => called.includes(t));
    const pass = !error && missing.length === 0 && forbidden.length === 0 && reply.length > 0;
    if (!pass) failures += 1;

    console.log(`${pass ? '✅' : '❌'} ${c.name}`);
    console.log(`   herramientas: [${called.join(', ') || '(ninguna)'}]`);
    if (missing.length) console.log(`   FALTARON: ${missing.join(', ')}`);
    if (forbidden.length) console.log(`   PROHIBIDAS LLAMADAS: ${forbidden.join(', ')}`);
    if (error) console.log(`   ERROR: ${error}`);
    console.log(`   respuesta: ${reply.slice(0, 140).replaceAll('\n', ' ')}`);
  }

  console.log(`\n${runs.length - failures}/${runs.length} casos OK`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
