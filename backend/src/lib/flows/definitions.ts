import { escapeHtml } from '../format';
import { changeUserName, normalizeName } from '../profile';
import type { FlowDef } from './engine';

/** Perfil: el nombre con el que el bot se dirige al usuario. */
const perfil: FlowDef = {
  id: 'perfil',
  title: 'perfil',
  steps: [
    {
      key: 'nombre',
      label: 'Nombre',
      kind: 'text',
      prompt: '👤 ¿Cómo quieres que te llame?',
      parse: (text) => {
        const nombre = normalizeName(text);
        return nombre
          ? { ok: true, value: nombre }
          : { ok: false, error: 'Usa solo letras, espacios, apóstrofo o guion (máximo 40 caracteres).' };
      },
    },
  ],
  summary: (data) => `👤 <b>Perfil</b>\n\nTe llamaré: <b>${escapeHtml(data.nombre ?? '')}</b>\n\n¿Lo guardo?`,
  commit: async (data) => {
    const result = await changeUserName(data.nombre ?? '');
    return result.ok ? `✅ Te llamaré <b>${escapeHtml(result.nombre)}</b>.` : `⚠️ ${escapeHtml(result.error)}`;
  },
};

export const FLOWS: Readonly<Record<string, FlowDef>> = { perfil };
