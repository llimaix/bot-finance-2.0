import { describe, expect, it } from 'vitest';
import { FLOWS } from '../src/lib/flows/definitions';
import { FLOW_TTL_MS, decodeCallback, isExpired, startState, step } from '../src/lib/flows/engine';
import type { FlowDef, FlowState } from '../src/lib/flows/engine';

const NOW = 1_000_000;
const NONCE = 'abc123';

/** Flujo de prueba: un paso de texto validado y uno de opción. */
const def: FlowDef = {
  id: 'prueba',
  title: 'prueba',
  steps: [
    {
      key: 'alias',
      label: 'Alias',
      kind: 'text',
      prompt: '¿Alias?',
      parse: (t) => (t.trim().length >= 2 ? { ok: true, value: t.trim() } : { ok: false, error: 'Muy corto' }),
    },
    {
      key: 'tipo',
      label: 'Tipo',
      kind: 'choice',
      prompt: '¿Tipo?',
      options: [
        { label: 'Débito', value: 'debito' },
        { label: 'Crédito', value: 'credito' },
      ],
    },
  ],
  summary: (d) => `Resumen: ${d.alias}/${d.tipo}`,
  commit: async () => 'guardado',
};

const start = (prefill = {}): FlowState => startState(def, prefill, NONCE, NOW).state!;
const callbacks = (r: ReturnType<typeof step>) =>
  r.messages.flatMap((m) => (m.keyboard ?? []).flat().map((b) => b.callback_data));

describe('motor de flujos: avance', () => {
  it('empieza en el primer paso y pregunta', () => {
    const r = startState(def, {}, NONCE, NOW);
    expect(r.state).toMatchObject({ flowId: 'prueba', step: 0, editing: false, expiresAt: NOW + FLOW_TTL_MS });
    expect(r.messages[0]!.html).toContain('¿Alias?');
    expect(r.messages[0]!.html).toContain('/cancelar');
  });

  it('texto válido → siguiente paso; opción → tarjeta de confirmación', () => {
    const r1 = step(def, start(), { type: 'text', text: 'la bac' });
    expect(r1.state).toMatchObject({ step: 1, data: { alias: 'la bac' } });
    expect(callbacks(r1)).toEqual([`flw:${NONCE}:o:0`, `flw:${NONCE}:o:1`]);

    const r2 = step(def, r1.state!, { type: 'option', index: 1 });
    expect(r2.state).toMatchObject({ step: null, data: { alias: 'la bac', tipo: 'credito' } });
    expect(r2.messages[0]!.html).toBe('Resumen: la bac/credito');
    expect(callbacks(r2)).toEqual([`flw:${NONCE}:ok`, `flw:${NONCE}:ed`, `flw:${NONCE}:x`]);
  });

  it('texto inválido → error y repite el mismo paso, sin avanzar', () => {
    const s = start();
    const r = step(def, s, { type: 'text', text: 'x' });
    expect(r.state).toBe(s);
    expect(r.messages[0]!.html).toContain('Muy corto');
    expect(r.messages[1]!.html).toContain('¿Alias?');
  });

  it('texto cuando se espera una opción → pide usar los botones', () => {
    const s = step(def, start(), { type: 'text', text: 'la bac' }).state!;
    const r = step(def, s, { type: 'text', text: 'crédito' });
    expect(r.state).toBe(s);
    expect(r.messages[0]!.html).toContain('botones');
  });

  it('con todos los pasos prellenados salta directo a la tarjeta (propuesta del agente)', () => {
    const r = startState(def, { alias: 'visa', tipo: 'credito' }, NONCE, NOW);
    expect(r.state!.step).toBeNull();
    expect(r.messages[0]!.html).toBe('Resumen: visa/credito');
  });
});

describe('motor de flujos: tarjeta', () => {
  const atSummary = (): FlowState => start({ alias: 'visa', tipo: 'debito' });

  it('✅ confirmar devuelve los datos a guardar y termina el flujo', () => {
    const r = step(def, atSummary(), { type: 'confirm' });
    expect(r.state).toBeNull();
    expect(r.commit).toEqual({ alias: 'visa', tipo: 'debito' });
  });

  it('❌ cancelar termina sin datos a guardar', () => {
    const r = step(def, atSummary(), { type: 'cancel' });
    expect(r.state).toBeNull();
    expect(r.commit).toBeUndefined();
    expect(r.messages[0]!.html).toContain('no guardé nada');
  });

  it('✏️ corregir un campo pregunta solo ese y vuelve a la tarjeta', () => {
    const menu = step(def, atSummary(), { type: 'editMenu' });
    expect(callbacks(menu)).toEqual([`flw:${NONCE}:e:0`, `flw:${NONCE}:e:1`, `flw:${NONCE}:sm`]);

    const editing = step(def, atSummary(), { type: 'edit', index: 0 });
    expect(editing.state).toMatchObject({ step: 0, editing: true });

    const back = step(def, editing.state!, { type: 'text', text: 'la azul' });
    expect(back.state).toMatchObject({ step: null, editing: false, data: { alias: 'la azul', tipo: 'debito' } });
  });

  it('confirmar fuera de la tarjeta no hace nada', () => {
    const s = start();
    const r = step(def, s, { type: 'confirm' });
    expect(r.state).toBe(s);
    expect(r.commit).toBeUndefined();
  });

  it('cancelar funciona en cualquier paso', () => {
    expect(step(def, start(), { type: 'cancel' }).state).toBeNull();
  });
});

describe('callbacks y expiración', () => {
  it('decodifica las acciones y rechaza datos ajenos o malformados', () => {
    expect(decodeCallback('flw:abc123:ok')).toEqual({ nonce: 'abc123', event: { type: 'confirm' } });
    expect(decodeCallback('flw:abc123:o:1')).toEqual({ nonce: 'abc123', event: { type: 'option', index: 1 } });
    expect(decodeCallback('flw:abc123:e:0')).toEqual({ nonce: 'abc123', event: { type: 'edit', index: 0 } });
    expect(decodeCallback('del:TXN#x')).toBeNull();
    expect(decodeCallback('flw:abc123:borrar')).toBeNull();
  });

  it('los callbacks caben en los 64 bytes de Telegram', () => {
    const longest = `flw:${'a'.repeat(10)}:e:99`;
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(64);
  });

  it('expira a las 24 h', () => {
    const s = start();
    expect(isExpired(s, NOW + FLOW_TTL_MS - 1)).toBe(false);
    expect(isExpired(s, NOW + FLOW_TTL_MS)).toBe(true);
  });
});

describe('flujo de perfil', () => {
  const perfil = FLOWS.perfil!;

  it('valida el nombre en el paso de texto', () => {
    const s = startState(perfil, {}, NONCE, NOW).state!;
    expect(step(perfil, s, { type: 'text', text: 'Luis123' }).state).toBe(s);
    expect(step(perfil, s, { type: 'text', text: '  Luis  ' }).state).toMatchObject({ step: null, data: { nombre: 'Luis' } });
  });

  it('la tarjeta escapa el HTML del nombre', () => {
    expect(perfil.summary({ nombre: '<b>x' })).toContain('&lt;b&gt;x');
  });
});
