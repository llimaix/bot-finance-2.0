/**
 * Set de evaluación GOLDEN del agente — casos reales salidos de los diálogos
 * de Allan (incluidos los que fallaron en producción). Corre contra el modelo
 * real con dependencias simuladas en memoria y valida qué herramientas llama.
 *
 * Uso:  ANTHROPIC_API_KEY=sk-... pnpm tsx scripts/eval-agent.ts [filtro] [--times N]
 *       LLM_PROVIDER=minimax MINIMAX_API_KEY=... pnpm tsx scripts/eval-agent.ts
 * (correrlo antes de deployar cambios de prompts/herramientas/proveedor; el
 * filtro corre solo los casos cuyo nombre lo contenga, N veces — estabilidad)
 */
import { runAgent } from '../src/lib/ai/agent';
import type { AgentDeps } from '../src/lib/ai/agent';
import { config } from '../src/lib/config';
import { toQuetzales } from '../src/lib/currency';
import type { ConversationMessage, Transaction } from '../src/lib/types';

const keyName = config.llmProvider === 'minimax' ? 'MINIMAX_API_KEY' : 'ANTHROPIC_API_KEY';
if (!process.env[keyName]) {
  console.error(`❌ Falta ${keyName} en el entorno (proveedor: ${config.llmProvider}).`);
  process.exit(1);
}
console.log(`Proveedor: ${config.llmProvider} · modelo del agente: ${config.llmModelAgent}\n`);

interface GoldenCase {
  name: string;
  user: string;
  /** Herramientas que DEBE llamar. */
  expectTools: string[];
  /** Herramientas que NO debe llamar. */
  forbidTools?: string[];
  /** Validación extra sobre los inputs de las herramientas y la respuesta (null = OK). */
  check?: (inputs: Record<string, unknown[]>, reply: string) => string | null;
  /** Movimientos recientes en el contexto ('completo' = ayer y hoy, default). */
  recent?: 'completo' | 'solo-ayer';
  /** Historia previa de la conversación (memoria CONV), para casos multi-turno. */
  history?: ConversationMessage[];
}

const CASES: GoldenCase[] = [
  { name: 'saludo no registra', user: 'Hola, ¿cómo estás?', expectTools: [], forbidTools: ['registrar_movimientos', 'dia_sin_movimientos'] },
  { name: 'gasto simple', user: 'gasté Q45 en almuerzo en efectivo', expectTools: ['registrar_movimientos'] },
  { name: 'retroactivo', user: 'ayer gasté Q80 de gasolina con la de débito', expectTools: ['registrar_movimientos'] },
  // solo-ayer: con movimientos de hoy en el contexto, "hoy nada" sería contradictorio
  { name: 'día sin movimientos', user: 'hoy nada', expectTools: ['dia_sin_movimientos'], forbidTools: ['registrar_movimientos'], recent: 'solo-ayer' },
  { name: 'pregunta de saldo', user: '¿Cuánto dinero tengo ahora?', expectTools: ['consultar_datos'], forbidTools: ['registrar_movimientos'] },
  // El contexto dice Banrural Q40: corregir a Q25 SÍ requiere ajustar_cuenta.
  // (Con el valor ya correcto el agente responde "ya lo tengo así" sin escribir
  // — comportamiento deseado desde la guarda de reconciliación.)
  { name: 'corrección de cuenta (incidente Banrural)', user: 'en banrural solo tengo 25 quetzales', expectTools: ['ajustar_cuenta'], forbidTools: ['registrar_movimientos'] },
  { name: 'hecho durable', user: 'mi salario cae el 15 y el 29 de cada mes, recordalo', expectTools: ['recordar_dato'] },
  { name: 'pregunta histórica', user: '¿cuánto gasté en farmacias en mayo?', expectTools: ['buscar_movimientos'] },
  { name: 'editar método (incidente débito)', user: 'los pagos 4, 5 y 6 de hoy fueron con débito y no crédito, ajustalos', expectTools: ['corregir_movimiento'], forbidTools: ['registrar_movimientos'] },
  { name: 'borrar movimiento', user: 'borra el movimiento 3 de hoy', expectTools: ['eliminar_movimiento'] },
  { name: 'veredicto de compra', user: 'me quiero comprar la play 5, ¿me alcanza?', expectTools: ['consultar_datos'], forbidTools: ['registrar_movimientos'] },
  // Incidente 11-jul: reconciliar NO es registrar. El usuario re-explica para qué
  // fueron los dos retiros que YA están registrados (ver contexto); el agente debe
  // consultar/responder, NUNCA crear "préstamo" ni "salida" como gastos nuevos.
  // Lo que guarda este caso es NO registrar duplicados; responder el saldo
  // puede salir de consultar_datos O del contexto (los saldos van frescos en
  // el system prompt), así que no se exige la herramienta.
  {
    name: 'reconciliación no duplica (incidente 11-jul)',
    user: 'Pongámonos en orden con lo de ayer: esos dos retiros de mil que ya tenés anotados, uno fue para prestarle a mamá y el otro para la salida con amigos. Solo quiero cuadrar, ¿cómo me quedó el efectivo?',
    expectTools: [],
    forbidTools: ['registrar_movimientos'],
  },
  {
    name: 'meta de gasto por chat',
    user: 'ponme una meta de 1500 al mes en comida',
    expectTools: ['fijar_meta'],
    forbidTools: ['registrar_movimientos', 'recordar_dato'],
  },
  // Incidente 14-jul (2): tras fallar una FOTO por timeout, "Intenta de nuevo"
  // debe pedir el reenvío de la foto — el agente no puede verla, y NO debe
  // re-ejecutar acciones viejas de la memoria (re-marcó "sin movimientos").
  {
    name: 'reintento tras foto fallida pide reenvío (incidente 14-jul)',
    user: 'Intenta de nuevo',
    history: [
      { role: 'user', text: 'hoy nada', at: '2026-07-12T23:14:00Z' },
      { role: 'assistant', text: 'Listo, marqué hoy sin movimientos.', at: '2026-07-12T23:14:10Z' },
      {
        role: 'user',
        text: '[📷 foto de comprobante] Realicé este pago con mi tarjeta de débito, corresponde al API de MiniMax',
        at: '2026-07-13T02:07:00Z',
      },
      {
        role: 'assistant',
        text: '[FALLÓ con este error] ⏳ Me tardé más de la cuenta pensando en eso y lo corté. Inténtalo de nuevo, o divídelo en partes más pequeñas.',
        at: '2026-07-13T02:08:00Z',
      },
    ],
    expectTools: [],
    forbidTools: ['dia_sin_movimientos', 'registrar_movimientos', 'corregir_movimiento', 'eliminar_movimiento'],
    check: () => null,
  },
  // Incidente 13-jul: pagos en dólares (Anthropic $100/mes). El agente registra
  // con currency USD y el CÓDIGO convierte a Q — nunca debe quedar Q100.
  // Incidente 14-jul: tras aclarar la ambigüedad, "hoy no hice movimientos" debe
  // marcar el día A LA PRIMERA — sin re-preguntar (acción inofensiva) y sin
  // confundir el gym de AYER con un movimiento de hoy.
  {
    name: 'hoy nada tras aclarar no re-pregunta (incidente 14-jul)',
    user: 'El día de hoy no he realizado ningún movimiento financiero',
    history: [
      { role: 'user', text: 'Si movimientos de momento', at: '2026-07-12T23:12:00Z' },
      {
        role: 'assistant',
        text: '¿Me confirmas si quisiste decir "sin movimientos" hoy, o si tienes algún movimiento nuevo que registrar? No quiero marcarlo mal.',
        at: '2026-07-12T23:12:30Z',
      },
    ],
    expectTools: ['dia_sin_movimientos'],
    forbidTools: ['registrar_movimientos', 'corregir_movimiento', 'eliminar_movimiento'],
    recent: 'solo-ayer',
  },
  // Incidente 15-jul: pregunta de DECISIÓN ("¿pago el 16 o espero al límite?")
  // respondida con un volcado de estatus (imitó el formato de una respuesta
  // anterior en la memoria). La respuesta debe ser una RECOMENDACIÓN.
  {
    name: 'decisión de pago de tarjeta responde la pregunta (incidente 15-jul)',
    user: 'la pregunta es si pago el 16 o si espero una fecha mas proxima a mi fecha de pago limite que es el 8?',
    history: [
      { role: 'user', text: 'Dame mi estatus', at: '2026-07-11T03:29:00Z' },
      {
        role: 'assistant',
        text: '📊 Tu estatus al 11 de julio de 2026\n\nSaldos\n• Banco Industrial (BI): Q716.66\n• Banrural: Q40.00\n• Tarjeta BAC: -Q5,026.07\n\nNeto líquido: -Q3,824.41',
        at: '2026-07-11T03:29:30Z',
      },
      {
        role: 'user',
        text: 'necesito un consejo financiero: mi fecha de corte de la tarjeta es el 15 (hoy) y mi fecha límite de pago es el 8, ¿me recomiendas pagar mañana ya que tengo liquidez?',
        at: '2026-07-12T17:52:00Z',
      },
      {
        role: 'assistant',
        text: 'Te recomiendo pagar mañana 16. Paga el total para no generar intereses.',
        at: '2026-07-12T17:52:30Z',
      },
    ],
    expectTools: [],
    forbidTools: ['registrar_movimientos', 'dia_sin_movimientos'],
    // El bug original fue responder con un VOLCADO de estatus en vez de decidir.
    // Eso es lo que guardamos; el fraseo de la recomendación lo deja libre a M3.
    check: (_inputs, reply) => {
      const montos = reply.match(/Q-?[\d,]+\.\d{2}/g)?.length ?? 0;
      if (/tu estatus/i.test(reply) || montos >= 4) {
        return `respondió con un volcado de estatus (${montos} montos) en vez de la decisión`;
      }
      return null;
    },
  },
  // Incidente 15/17-jul: el agente AFIRMÓ "✅ Registrado" sin llamar ninguna
  // herramienta — la quincena y el pago de tarjeta jamás se guardaron. Estos
  // dos casos exigen la ESCRITURA real, no solo la respuesta triunfal.
  {
    name: 'quincena reportada se registra de verdad (incidente 15-jul)',
    user: 'Ya me cayó mi pago de la primer quincena, esto va directo de manera automática a la cuenta BI, el monto es Q7,500',
    expectTools: ['registrar_movimientos'],
    check: (inputs) => {
      const first = inputs['registrar_movimientos']?.[0] as
        | { transactions: Array<{ amount: number; type: string }> }
        | undefined;
      return first?.transactions.some((t) => t.amount === 7500 && t.type === 'ingreso')
        ? null
        : `esperaba ingreso de Q7,500; vino: ${JSON.stringify(first?.transactions)}`;
    },
  },
  // El contexto muestra BI menor a la deuda: la realidad confirmada por el
  // usuario MANDA (sus datos pueden estar desactualizados por un registro
  // faltante — exactamente lo que pasó). Debe registrar y señalar el descuadre.
  {
    name: 'pago total de tarjeta se registra de verdad (incidente 17-jul)',
    user: 'Te confirmo que ya cancelé la tarjeta de crédito: pagué los Q4,246.37 completos desde BI, regístralo',
    expectTools: ['registrar_movimientos'],
    check: (inputs) => {
      const first = inputs['registrar_movimientos']?.[0] as
        | { transactions: Array<{ amount: number; type: string; method: string }> }
        | undefined;
      return first?.transactions.some((t) => t.type === 'transferencia' && t.amount > 4000)
        ? null
        : `esperaba transferencia (pago de tarjeta) > Q4,000; vino: ${JSON.stringify(first?.transactions)}`;
    },
  },
  // Incidente 18-20 jul: el guardián recuerda Tigo/Apple; Allan dice que ya
  // están pagados (cargo automático). Debe MARCARLOS pagados, no solo decir
  // "ok" — sin la herramienta el guardián seguía insistiendo cada día.
  {
    name: 'recurrente ya pagado se marca de verdad (incidente 18-jul)',
    user: 'Tigo ya está pagado, es automático, no hay que registrar nada de monto',
    history: [
      {
        role: 'assistant',
        text: '🛡️ Guardián financiero\n\n🔔 No veo el pago de Tigo este mes (~Q329.00, suele caer el día 6). ¿Ya lo pagaste?',
        at: '2026-07-12T14:30:00Z',
      },
    ],
    expectTools: ['marcar_recurrente_pagado'],
    forbidTools: ['registrar_movimientos'],
  },
  // "Ante cualquier duda, preguntar": un gasto sin método claro NO se registra
  // con 'na' (inflaría el neto sin tocar cuenta); el agente pregunta la cuenta.
  // Un gasto sin método claro se REGISTRA igual (con 'na', cuenta pendiente):
  // nunca se pierde. El sistema pregunta la cuenta después (guarda/completación
  // determinista), no el agente reteniéndolo — retenerlo perdía el dato (TV 24-jul).
  {
    name: 'gasto sin cuenta clara se registra (cuenta pendiente)',
    user: 'gasté 50 quetzales en unas cosas',
    expectTools: ['registrar_movimientos'],
    check: (inputs) => {
      const first = inputs['registrar_movimientos']?.[0] as
        | { transactions: Array<{ amount: number; type: string }> }
        | undefined;
      return first?.transactions.some((t) => t.amount === 50 && t.type === 'gasto')
        ? null
        : `esperaba un gasto de Q50 registrado; vino: ${JSON.stringify(first?.transactions)}`;
    },
  },
  // Incidente 21-jul: con movimientos SOLO de ayer, "hoy no hubieron movimientos"
  // debe marcar el día sin confundir los de ayer con los de hoy.
  {
    name: 'hoy nada no confunde ayer con hoy (incidente 21-jul)',
    user: 'Hoy no hubieron movimientos',
    expectTools: ['dia_sin_movimientos'],
    forbidTools: ['registrar_movimientos', 'corregir_movimiento', 'eliminar_movimiento'],
    recent: 'solo-ayer',
    check: (_inputs, reply) =>
      /hoy (?:ya )?(?:hay|tienes|ten[eé]s|se registr|tenemos|est[aá]n)/i.test(reply)
        ? `trató los movimientos de ayer como de hoy: "${reply.slice(0, 120)}"`
        : null,
  },
  {
    name: 'pago en dólares registra en USD',
    user: 'pagué la suscripción de Anthropic con la de crédito, son 100 dólares',
    expectTools: ['registrar_movimientos'],
    check: (inputs) => {
      const first = inputs['registrar_movimientos']?.[0] as
        | { transactions: Array<{ currency: string; amount: number }> }
        | undefined;
      const txns = first?.transactions ?? [];
      return txns.some((t) => t.currency === 'USD' && t.amount === 100)
        ? null
        : `esperaba currency USD con amount 100 (dólares tal cual); vino: ${JSON.stringify(txns)}`;
    },
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

const CONTEXT_BASE = [
  'Cuentas (saldo actual): Banco Industrial (BI) [id:banco]: Q2,101.01; Banrural [id:banrural]: Q40.00; Tarjeta BAC [id:tarjeta]: Q-4,246.37; Efectivo [id:efectivo]: Q700.00 (estimado); Kash [id:kash]: Q0.00 (estimado).',
  'Catálogo de categorías: comida, supermercado, transporte, hogar, salud, educacion, entretenimiento, servicios, suscripciones, ahorro, deuda, tecnologia, viajes, otros.',
  'Hechos que Allan te ha enseñado:\n- Energuate es su pago de energía eléctrica (categoría servicios).',
];

// Mismo formato de DOS SECCIONES que produce agentFlow (renderRecentSection).
const AYER = [
  '  - #1 Q1,000.00 debito retiro · Retiro de cajero para gastos de préstamos',
  '  - #2 Q1,000.00 debito retiro · Retiro para salida con amigos',
  '  - #3 Q10.00 efectivo gasto · Pago de gym',
];

const HOY = [
  '  - #1 Q120.00 efectivo gasto · Cena con novia',
  '  - #2 Q78.51 credito gasto · SAT2000',
  '  - #3 Q75.00 credito gasto · SAT2000',
  '  - #4 Q153.00 credito gasto · Neonet Guatemala',
  '  - #5 Q195.00 credito gasto · Claro',
  '  - #6 Q329.00 credito gasto · Internet residencial',
];

function recentSections(recent: 'completo' | 'solo-ayer'): string {
  const hoy = recent === 'solo-ayer' ? [] : HOY;
  const secHoy =
    hoy.length === 0
      ? 'Movimientos registrados HOY (2026-07-12): NINGUNO'
      : `Movimientos registrados HOY (2026-07-12): ${hoy.length}\n${hoy.join('\n')}`;
  const secAyer = `Movimientos registrados AYER (2026-07-11): ${AYER.length}\n${AYER.join('\n')}`;
  return `${secHoy}\n${secAyer}\nLos movimientos de arriba YA están registrados: NO los vuelvas a registrar. Si alguno hay que cambiarlo, usa corregir_movimiento/eliminar_movimiento con su número y su fecha.`;
}

function buildDeps(
  called: string[],
  inputs: Record<string, unknown[]> = {},
  opts: { recent?: 'completo' | 'solo-ayer' } = {},
): AgentDeps {
  const track = <T>(name: string, value: T, input?: unknown): T => {
    called.push(name);
    if (input !== undefined) (inputs[name] ??= []).push(input);
    return value;
  };
  return {
    today: '2026-07-12',
    contextInfo: [...CONTEXT_BASE, recentSections(opts.recent ?? 'completo')].join('\n'),
    register: async (input) =>
      track(
        'registrar_movimientos',
        {
          // Eco del input real (con la conversión USD→Q de producción): un mock
          // incoherente ("almuerzo Q45" fijo) hace que un modelo atento crea
          // que el sistema falla y reintente.
          txns: input.transactions.map((t, i) => {
            const q = toQuetzales(t, 7.8);
            return {
              ...fakeTxn(7 + i),
              amount: q.amount,
              type: q.type,
              category: q.category,
              method: q.method,
              description: q.description,
              ...(q.date ? { date: q.date } : {}),
            };
          }),
          createdCategories: [],
          totalSpentToday: 145,
          advertencias: [],
        },
        input,
      ),
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
    markRecurringPaid: async ({ descripcion }) =>
      track('marcar_recurrente_pagado', { ok: true, marcadoPagado: { descripcion, mes: '2026-07' } }),
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
  // Sin --times, timesIdx+1 era 0 y el filtro descartaba su propio argumento.
  const positional = timesIdx >= 0 ? args.filter((_, i) => i !== timesIdx && i !== timesIdx + 1) : args;
  const filter = positional[0];

  const selected = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES;
  const runs = Array.from({ length: Math.max(1, times) }, () => selected).flat();

  let failures = 0;
  for (const c of runs) {
    const called: string[] = [];
    const inputs: Record<string, unknown[]> = {};
    let reply = '';
    let error: string | null = null;
    try {
      const result = await runAgent(c.user, c.history ?? [], buildDeps(called, inputs, { recent: c.recent }), { timeoutMs: 90_000 });
      reply = result.text;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const missing = c.expectTools.filter((t) => !called.includes(t));
    const forbidden = (c.forbidTools ?? []).filter((t) => called.includes(t));
    const checkError = error ? null : (c.check?.(inputs, reply) ?? null);
    const pass = !error && missing.length === 0 && forbidden.length === 0 && !checkError && reply.length > 0;
    if (!pass) failures += 1;

    console.log(`${pass ? '✅' : '❌'} ${c.name}`);
    console.log(`   herramientas: [${called.join(', ') || '(ninguna)'}]`);
    if (missing.length) console.log(`   FALTARON: ${missing.join(', ')}`);
    if (forbidden.length) console.log(`   PROHIBIDAS LLAMADAS: ${forbidden.join(', ')}`);
    if (checkError) console.log(`   CHECK: ${checkError}`);
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
