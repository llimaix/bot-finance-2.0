import { describe, expect, it } from 'vitest';
import { BOT_COMMANDS, matchCommand } from '../src/lib/commands';

describe('BOT_COMMANDS (menú de Telegram)', () => {
  it('incluye /metas y /costo, que faltaban en el menú registrado', () => {
    const names = BOT_COMMANDS.map((c) => c.command);
    expect(names).toContain('metas');
    expect(names).toContain('costo');
  });

  it('cada comando del menú lo reconoce el parser', () => {
    for (const { command } of BOT_COMMANDS) {
      expect(matchCommand(`/${command}`), `/${command}`).not.toBeNull();
    }
  });

  it('cumple las reglas de Telegram: nombre en minúsculas de 1 a 32 caracteres y descripción de 1 a 256', () => {
    const names = BOT_COMMANDS.map((c) => c.command);
    expect(new Set(names).size).toBe(names.length);
    for (const { command, description } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThanOrEqual(1);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });
});
