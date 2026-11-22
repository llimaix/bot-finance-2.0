/**
 * Conversión de monedas para pagos en USD (suscripciones internacionales en
 * la TC: Anthropic, Apple, etc.). El LLM solo MARCA la moneda; los números
 * los convierte este código con el tipo de cambio configurado.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CurrencyFields {
  amount: number;
  currency: 'GTQ' | 'USD';
  description: string;
}

/**
 * Convierte a quetzales si el monto viene en USD, anotando la conversión en
 * la descripción con la MISMA convención de la ingesta de estados de cuenta
 * ("(USD 100 ≈ Q780 a 7.80)") — la descripción normalizada queda idéntica
 * entre meses y el detector de recurrentes agrupa el concepto.
 */
export function toQuetzales<T extends CurrencyFields>(txn: T, rate: number): Omit<T, 'currency'> {
  const { currency, ...rest } = txn;
  if (currency !== 'USD') return rest;
  const amount = round2(txn.amount * rate);
  return {
    ...rest,
    amount,
    description: `${txn.description} (USD ${txn.amount} ≈ Q${amount} a ${rate.toFixed(2)})`,
  };
}
