#!/usr/bin/env node
/**
 * Registra el webhook del bot en Telegram. Idempotente: se ejecuta en cada
 * deploy (paso final del workflow) y también sirve manualmente.
 *
 * Resuelve la URL en este orden:
 *   1. argumento CLI:        node scripts/set-webhook.mjs https://xxxx.execute-api...
 *   2. env WEBHOOK_URL
 *   3. cdk-outputs.json      (generado por `cdk deploy --outputs-file cdk-outputs.json`)
 *
 * Requiere env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
 */
import { readFileSync } from 'node:fs';

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token || !secret) {
  console.error('Faltan TELEGRAM_BOT_TOKEN y/o TELEGRAM_WEBHOOK_SECRET en el entorno.');
  process.exit(1);
}

let url = process.argv[2] ?? process.env.WEBHOOK_URL;
if (!url) {
  try {
    const outputs = JSON.parse(readFileSync('cdk-outputs.json', 'utf8'));
    url = outputs.FinanzasStack?.WebhookUrl;
  } catch {
    // sin outputs file
  }
}
if (!url) {
  console.error('No encontré la URL del webhook (argumento, WEBHOOK_URL o cdk-outputs.json).');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url,
    secret_token: secret,
    // callback_query: botones inline de borrado bajo cada confirmación
    allowed_updates: ['message', 'callback_query'],
    // false: no descartar updates pendientes en cada deploy
    drop_pending_updates: false,
  }),
});

const data = await res.json();
if (!data.ok) {
  console.error('setWebhook falló:', data.description ?? data);
  process.exit(1);
}
console.log(`✅ Webhook registrado: ${url}`);

// Menú de comandos (autocompletado al escribir "/" en Telegram).
// Mantener en sincronía con BOT_COMMANDS en src/lib/commands.ts.
const commands = [
  { command: 'hoy', description: 'Movimientos del día' },
  { command: 'semana', description: 'Resumen de los últimos 7 días' },
  { command: 'mes', description: 'Resumen del mes en curso' },
  { command: 'reporte', description: 'Reporte del mes con análisis' },
  { command: 'nada', description: 'Registrar día sin movimientos' },
  { command: 'categorias', description: 'Ver la base de conocimientos de categorías' },
  { command: 'saldo', description: 'Saldos de tus cuentas' },
  { command: 'recurrentes', description: 'Gastos recurrentes aprendidos' },
  { command: 'export', description: 'Exportar el mes en curso como CSV' },
  { command: 'borrar', description: 'Eliminar el movimiento #N de hoy' },
  { command: 'ayuda', description: 'Cómo usar el bot' },
];

const cmdRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ commands }),
});
const cmdData = await cmdRes.json();
if (!cmdData.ok) {
  console.error('setMyCommands falló:', cmdData.description ?? cmdData);
  process.exit(1);
}
console.log(`✅ Menú de comandos registrado (${commands.length} comandos)`);
