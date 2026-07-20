import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAgentModel, getModel, getVisionModel, stripThinking } from '../src/lib/ai/llm';

// El factory no hace llamadas de red al construir el modelo: se puede probar en unit.
afterEach(() => {
  vi.unstubAllEnvs();
});

interface ModelLike {
  modelId: string;
  provider: string;
}

describe('getModel', () => {
  it('anthropic por defecto (incluso con LLM_PROVIDER vacío, como llega de CI)', () => {
    vi.stubEnv('LLM_PROVIDER', '');
    vi.stubEnv('LLM_MODEL', '');
    const model = getModel() as ModelLike;
    expect(model.modelId).toBe('claude-haiku-4-5');
    expect(model.provider).toContain('anthropic');
  });

  it('minimax con sus env vars', () => {
    vi.stubEnv('LLM_PROVIDER', 'minimax');
    vi.stubEnv('LLM_MODEL', 'MiniMax-M3');
    vi.stubEnv('MINIMAX_API_KEY', 'test-key');
    const model = getModel() as ModelLike;
    expect(model.modelId).toBe('MiniMax-M3');
    expect(model.provider).toContain('minimax');
  });

  it('minimax sin API key falla con mensaje claro', () => {
    vi.stubEnv('LLM_PROVIDER', 'minimax');
    vi.stubEnv('MINIMAX_API_KEY', '');
    expect(() => getModel()).toThrow(/MINIMAX_API_KEY/);
  });

  it('proveedor desconocido falla con mensaje claro', () => {
    vi.stubEnv('LLM_PROVIDER', 'chatgpt5000');
    expect(() => getModel()).toThrow(/no soportado/);
  });

  it('minimax sin LLM_MODEL ni LLM_MODEL_AGENT cae a MiniMax-M3 (default por proveedor)', () => {
    vi.stubEnv('LLM_PROVIDER', 'minimax');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_MODEL_AGENT', '');
    vi.stubEnv('MINIMAX_API_KEY', 'test-key');
    expect((getModel() as ModelLike).modelId).toBe('MiniMax-M3');
    expect((getAgentModel() as ModelLike).modelId).toBe('MiniMax-M3');
  });
});

describe('getVisionModel', () => {
  it('por defecto sigue al proveedor/modelo principal', () => {
    vi.stubEnv('LLM_PROVIDER', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_PROVIDER_VISION', '');
    vi.stubEnv('LLM_MODEL_VISION', '');
    const model = getVisionModel() as ModelLike;
    expect(model.modelId).toBe('claude-haiku-4-5');
    expect(model.provider).toContain('anthropic');
  });

  it('separable: MiniMax para texto + Anthropic para comprobantes', () => {
    vi.stubEnv('LLM_PROVIDER', 'minimax');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('MINIMAX_API_KEY', 'test-key');
    vi.stubEnv('LLM_PROVIDER_VISION', 'anthropic');
    vi.stubEnv('LLM_MODEL_VISION', '');
    const vision = getVisionModel() as ModelLike;
    expect(vision.modelId).toBe('claude-haiku-4-5');
    expect(vision.provider).toContain('anthropic');
    // el resto del sistema sigue en minimax
    expect((getModel() as ModelLike).provider).toContain('minimax');
  });
});

describe('stripThinking', () => {
  it('quita el bloque <think> de los modelos razonadores (MiniMax-M3)', () => {
    expect(stripThinking('<think>\nEl usuario saluda. Respondo corto.\n</think>\n\n¡Hola Allan!')).toBe('¡Hola Allan!');
  });

  it('quita múltiples bloques y conserva el resto', () => {
    expect(stripThinking('<think>a</think>Listo, registrado.<think>b</think> ¿Algo más?')).toBe('Listo, registrado. ¿Algo más?');
  });

  it('tag sin cerrar (salida truncada): corta desde ahí', () => {
    expect(stripThinking('Anotado 👍\n<think>ahora debería')).toBe('Anotado 👍');
    expect(stripThinking('<think>solo pensamiento truncado')).toBe('');
  });

  it('texto sin tags pasa intacto', () => {
    expect(stripThinking('  Listo, Q45 registrados.  ')).toBe('Listo, Q45 registrados.');
  });

  it('variante con namespace <mm:think> y cierre huérfano', () => {
    expect(stripThinking('<mm:think>razono</mm:think>Listo.')).toBe('Listo.');
    expect(stripThinking('</mm:think>¿Me reenvías la foto?')).toBe('¿Me reenvías la foto?');
    expect(stripThinking('Anotado.<mm:think>truncado sin cierre')).toBe('Anotado.');
  });
});

describe('ANNOUNCE_RE (anuncio sin acción)', () => {
  it('detecta promesas vacías', async () => {
    const { ANNOUNCE_RE } = await import('../src/lib/ai/agent');
    expect(ANNOUNCE_RE.test('⌛ Espera un momento, estoy consultando tus datos.')).toBe(true);
    expect(ANNOUNCE_RE.test('Déjame revisar tus movimientos')).toBe(true);
    expect(ANNOUNCE_RE.test('Voy a consultar tu saldo')).toBe(true);
  });

  it('no confunde respuestas reales', async () => {
    const { ANNOUNCE_RE } = await import('../src/lib/ai/agent');
    expect(ANNOUNCE_RE.test('Tenés Q2,101.01 en BI y Q40 en Banrural.')).toBe(false);
    expect(ANNOUNCE_RE.test('Listo, registré tus Q45 de almuerzo.')).toBe(false);
  });
});

describe('CLAIM_RE (afirmación sin escritura)', () => {
  it('detecta afirmaciones de acciones', async () => {
    const { CLAIM_RE } = await import('../src/lib/ai/agent');
    expect(CLAIM_RE.test('✅ Registrado tu pago de quincena')).toBe(true);
    expect(CLAIM_RE.test('Listo, quedó anotado el gasto')).toBe(true);
    expect(CLAIM_RE.test('La paso a memoria para no olvidarlo')).toBe(true);
    expect(CLAIM_RE.test('Ajustado, Banrural queda en Q25')).toBe(true);
  });

  it('no confunde consultas ni consejos', async () => {
    const { CLAIM_RE } = await import('../src/lib/ai/agent');
    expect(CLAIM_RE.test('Tenés Q3,190.59 en BI y la tarjeta en cero.')).toBe(false);
    expect(CLAIM_RE.test('Te recomiendo pagar mañana: maximizas tu colchón.')).toBe(false);
    expect(CLAIM_RE.test('En mayo gastaste Q716 en farmacias.')).toBe(false);
  });
});

describe('CLAIM_RE ampliado (incidente cena "Hecho")', () => {
  it('cubre "Hecho", "sale de tu efectivo" y primera persona', async () => {
    const { CLAIM_RE } = await import('../src/lib/ai/agent');
    expect(CLAIM_RE.test('Hecho: Q150 de cena, efectivo.')).toBe(true);
    expect(CLAIM_RE.test('Entendido: Q100 perdidos en apuesta, sale de tu efectivo.')).toBe(true);
    expect(CLAIM_RE.test('Ya registré tus Q45 de almuerzo.')).toBe(true);
    expect(CLAIM_RE.test('Lo marqué como pagado este mes.')).toBe(true);
  });
});

describe('REGISTER_INTENT_RE (activa la red de seguridad)', () => {
  it('detecta mensajes que piden registrar un movimiento', async () => {
    const { REGISTER_INTENT_RE } = await import('../src/lib/ai/agent');
    expect(REGISTER_INTENT_RE.test('Necesito registrar otro gasto de efectivo pago de hotel anoche 135 quetzales')).toBe(true);
    expect(REGISTER_INTENT_RE.test('Otro gasto de efectivo 100 quetzales en cena con familia de mi novia')).toBe(true);
    expect(REGISTER_INTENT_RE.test('compré botas Q450')).toBe(true);
    expect(REGISTER_INTENT_RE.test('me cayó la quincena Q7500')).toBe(true);
    expect(REGISTER_INTENT_RE.test('retiré 1000 del cajero')).toBe(true);
  });

  it('no dispara en consultas ni saludos', async () => {
    const { REGISTER_INTENT_RE } = await import('../src/lib/ai/agent');
    expect(REGISTER_INTENT_RE.test('Dame los últimos 10 movimientos de efectivo')).toBe(false);
    expect(REGISTER_INTENT_RE.test('¿Cuánto tengo en el banco?')).toBe(false);
    expect(REGISTER_INTENT_RE.test('Hola, ¿cómo estás?')).toBe(false);
    expect(REGISTER_INTENT_RE.test('Dame mi estatus')).toBe(false);
  });
});

describe('needsDeterministicRegister (guard contra doble registro)', () => {
  it('registra solo si NO hubo escritura y el usuario pidió registrar', async () => {
    const { needsDeterministicRegister } = await import('../src/lib/ai/agent');
    // agente no escribió + intención de registro → sí
    expect(needsDeterministicRegister(false, 'gasté Q135 en hotel')).toBe(true);
    // agente YA escribió (corrigió/ajustó/marcó) → NO re-registrar (bug #1)
    expect(needsDeterministicRegister(true, 'en realidad gasté Q60, corrígelo')).toBe(false);
    expect(needsDeterministicRegister(true, 'marca Tigo como pagado, ya me lo cobraron')).toBe(false);
    // sin intención de registro (consulta) → no
    expect(needsDeterministicRegister(false, 'dame los últimos 10 movimientos')).toBe(false);
    expect(needsDeterministicRegister(false, '¿me alcanza para la play 5?')).toBe(false);
  });
});

describe('needsNoWriteDisclaimer (honestidad sin falsos positivos)', () => {
  it('estampa solo afirmaciones de ESCRITURA sin escritura real', async () => {
    const { needsNoWriteDisclaimer } = await import('../src/lib/ai/agent');
    expect(needsNoWriteDisclaimer(false, '✅ Registrado tu gasto de Q45')).toBe(true);
    expect(needsNoWriteDisclaimer(false, 'Listo, ajustado a Q40')).toBe(true);
    // el agente SÍ escribió → sin disclaimer
    expect(needsNoWriteDisclaimer(true, '✅ Registrado tu gasto de Q45')).toBe(false);
    // veredicto de compra "✅ Sí te alcanza" NO es una escritura → sin disclaimer (bug #4)
    expect(needsNoWriteDisclaimer(false, '✅ Sí te alcanza, adelante con la compra.')).toBe(false);
    // "De hecho tenés..." (respuesta de consulta) NO debe disparar disclaimer
    expect(needsNoWriteDisclaimer(false, 'De hecho tenés Q3,190 en BI.')).toBe(false);
    // pero "Hecho: Q150 de cena" (confirmación falsa) sí
    expect(needsNoWriteDisclaimer(false, 'Hecho: Q150 de cena, efectivo.')).toBe(true);
  });
});

describe('stripThinking con anidamiento (fuga de razonamiento)', () => {
  it('no filtra el texto intermedio de bloques <think> anidados', async () => {
    const { stripThinking } = await import('../src/lib/ai/llm');
    expect(stripThinking('<think>externo <think>interno</think> sigo pensando</think>Respuesta')).toBe('Respuesta');
  });
  it('sigue manejando bloques separados correctamente', async () => {
    const { stripThinking } = await import('../src/lib/ai/llm');
    expect(stripThinking('<think>a</think>Listo.<think>b</think> ¿Algo más?')).toBe('Listo. ¿Algo más?');
  });
});
