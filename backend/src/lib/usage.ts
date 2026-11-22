import { escapeHtml } from './format';

/**
 * Contabilidad de tokens de IA: el acumulador vive en DynamoDB (item
 * USAGE#yyyy-mm, contadores atómicos con ADD) y aquí están las tarifas y el
 * render del comando /costo. Todo estimado — la verdad final la tiene el
 * dashboard del proveedor, pero esto responde al instante y sin sorpresas.
 */

/** USD por MILLÓN de tokens [entrada, salida], por prefijo de modelo. */
const MODEL_RATES: Array<{ prefix: string; in: number; out: number }> = [
  { prefix: 'MiniMax', in: 0.3, out: 1.2 }, // promo permanente 50% (jul-2026)
  { prefix: 'claude-haiku', in: 1.0, out: 5.0 },
  { prefix: 'claude-sonnet', in: 3.0, out: 15.0 },
];

export function rateFor(model: string): { in: number; out: number } | null {
  const rate = MODEL_RATES.find((r) => model.startsWith(r.prefix));
  return rate ? { in: rate.in, out: rate.out } : null;
}

/** Claves planas del item USAGE# (ADD atómico no funciona en mapas anidados). */
export const USAGE_KEYS = {
  model: (model: string, dir: 'in' | 'out') => `m_${dir}::${model}`,
  fn: (fn: string, dir: 'in' | 'out') => `f_${dir}::${fn}`,
} as const;

export interface UsageSummary {
  inTokens: number;
  outTokens: number;
  calls: number;
  porModelo: Array<{ model: string; inTokens: number; outTokens: number; costUsd: number | null }>;
  porFn: Array<{ fn: string; inTokens: number; outTokens: number }>;
  /** Suma de los modelos con tarifa conocida. */
  totalUsd: number;
}

/** Interpreta el item USAGE# crudo de DynamoDB. */
export function summarizeUsage(item: Record<string, unknown> | undefined): UsageSummary {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const models = new Map<string, { inTokens: number; outTokens: number }>();
  const fns = new Map<string, { inTokens: number; outTokens: number }>();

  for (const [key, value] of Object.entries(item ?? {})) {
    const m = key.match(/^([mf])_(in|out)::(.+)$/);
    if (!m) continue;
    const bucket = m[1] === 'm' ? models : fns;
    const entry = bucket.get(m[3]!) ?? { inTokens: 0, outTokens: 0 };
    if (m[2] === 'in') entry.inTokens += num(value);
    else entry.outTokens += num(value);
    bucket.set(m[3]!, entry);
  }

  const porModelo = [...models.entries()]
    .map(([model, t]) => {
      const rate = rateFor(model);
      const costUsd = rate
        ? Math.round(((t.inTokens * rate.in + t.outTokens * rate.out) / 1_000_000) * 100) / 100
        : null;
      return { model, ...t, costUsd };
    })
    .sort((a, b) => b.inTokens + b.outTokens - (a.inTokens + a.outTokens));

  const porFn = [...fns.entries()]
    .map(([fn, t]) => ({ fn, ...t }))
    .sort((a, b) => b.inTokens + b.outTokens - (a.inTokens + a.outTokens));

  return {
    inTokens: num(item?.inTokens),
    outTokens: num(item?.outTokens),
    calls: num(item?.calls),
    porModelo,
    porFn,
    totalUsd: Math.round(porModelo.reduce((acc, m) => acc + (m.costUsd ?? 0), 0) * 100) / 100,
  };
}

const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(n));

/** Mensaje del comando /costo. */
export function renderCosto(summary: UsageSummary, monthLabel: string): string {
  if (summary.calls === 0) {
    return `💸 Sin consumo de IA registrado en ${monthLabel} (el contador arrancó con esta versión).`;
  }
  const lines = [
    `💸 <b>Costo de IA — ${escapeHtml(monthLabel)}</b>`,
    '',
    `Total: ${fmtTok(summary.inTokens)} tokens de entrada · ${fmtTok(summary.outTokens)} de salida · ${summary.calls} llamadas`,
    `Estimado: ≈ $${summary.totalUsd.toFixed(2)} USD (tarifas vigentes por modelo)`,
  ];
  if (summary.porModelo.length > 0) {
    lines.push('', '<b>Por modelo:</b>');
    for (const m of summary.porModelo) {
      const cost = m.costUsd !== null ? ` ≈ $${m.costUsd.toFixed(2)}` : ' (tarifa desconocida)';
      lines.push(`• ${escapeHtml(m.model)}: ${fmtTok(m.inTokens)} in / ${fmtTok(m.outTokens)} out${cost}`);
    }
  }
  if (summary.porFn.length > 0) {
    lines.push('', '<b>Por función (top 5):</b>');
    for (const f of summary.porFn.slice(0, 5)) {
      lines.push(`• ${escapeHtml(f.fn)}: ${fmtTok(f.inTokens)} in / ${fmtTok(f.outTokens)} out`);
    }
  }
  return lines.join('\n');
}
