import { describe, expect, it } from 'vitest';
import { chatIdDiagnostics } from '../src/lib/chat-id';

describe('chatIdDiagnostics (log "chat no permitido")', () => {
  it('describe un chat ID válido sin incluir su valor', () => {
    const out = chatIdDiagnostics('1199338066');
    expect(out).toEqual({ esperadoLongitud: 10, esperadoNumerico: true });
    expect(JSON.stringify(out)).not.toContain('1199338066');
  });

  it('acepta IDs negativos (grupos)', () => {
    expect(chatIdDiagnostics('-1001234567890').esperadoNumerico).toBe(true);
  });

  it('delata formatos mal cargados: comillas, espacios o el token del bot', () => {
    expect(chatIdDiagnostics('"1199338066"').esperadoNumerico).toBe(false);
    expect(chatIdDiagnostics('1199338066 ').esperadoNumerico).toBe(false);
    expect(chatIdDiagnostics('123456789:AAE').esperadoNumerico).toBe(false);
  });
});
