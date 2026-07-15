import { describe, expect, it } from 'vitest';
import { rateFor, renderCosto, summarizeUsage } from '../src/lib/usage';

describe('rateFor', () => {
  it('resuelve tarifas por prefijo de modelo', () => {
    expect(rateFor('MiniMax-M3')).toEqual({ in: 0.3, out: 1.2 });
    expect(rateFor('claude-haiku-4-5')).toEqual({ in: 1, out: 5 });
    expect(rateFor('claude-sonnet-5')).toEqual({ in: 3, out: 15 });
    expect(rateFor('gpt-9-mega')).toBeNull();
  });
});

describe('summarizeUsage', () => {
  const item = {
    inTokens: 1_000_000,
    outTokens: 100_000,
    calls: 42,
    'm_in::MiniMax-M3': 900_000,
    'm_out::MiniMax-M3': 90_000,
    'm_in::claude-haiku-4-5': 100_000,
    'm_out::claude-haiku-4-5': 10_000,
    'f_in::runAgent': 800_000,
    'f_out::runAgent': 80_000,
    'f_in::parseReceipt': 200_000,
    'f_out::parseReceipt': 20_000,
  };

  it('agrega por modelo con costo y por función', () => {
    const s = summarizeUsage(item);
    expect(s.calls).toBe(42);
    const m3 = s.porModelo.find((m) => m.model === 'MiniMax-M3')!;
    // 0.9M × $0.30 + 0.09M × $1.20 = 0.27 + 0.108 = 0.38
    expect(m3.costUsd).toBe(0.38);
    const haiku = s.porModelo.find((m) => m.model === 'claude-haiku-4-5')!;
    // 0.1M × $1 + 0.01M × $5 = 0.1 + 0.05 = 0.15
    expect(haiku.costUsd).toBe(0.15);
    expect(s.totalUsd).toBe(0.53);
    expect(s.porFn[0]?.fn).toBe('runAgent');
  });

  it('item ausente = todo en cero', () => {
    const s = summarizeUsage(undefined);
    expect(s.calls).toBe(0);
    expect(s.totalUsd).toBe(0);
    expect(s.porModelo).toEqual([]);
  });
});

describe('renderCosto', () => {
  it('sin consumo lo dice claro', () => {
    expect(renderCosto(summarizeUsage(undefined), 'julio 2026')).toContain('Sin consumo');
  });

  it('muestra totales, estimado y desgloses', () => {
    const text = renderCosto(
      summarizeUsage({
        inTokens: 500_000,
        outTokens: 50_000,
        calls: 10,
        'm_in::MiniMax-M3': 500_000,
        'm_out::MiniMax-M3': 50_000,
        'f_in::runAgent': 500_000,
        'f_out::runAgent': 50_000,
      }),
      'julio 2026',
    );
    expect(text).toContain('julio 2026');
    expect(text).toContain('500K');
    expect(text).toContain('$0.21'); // 0.5×0.3 + 0.05×1.2 = 0.15+0.06
    expect(text).toContain('MiniMax-M3');
    expect(text).toContain('runAgent');
  });
});
