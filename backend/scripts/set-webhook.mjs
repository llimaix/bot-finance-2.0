#!/usr/bin/env node
/**
 * Registra el webhook del bot y su menú de comandos en Telegram. Idempotente:
 * lo ejecuta el workflow manual telegram-webhook y también sirve en local.
 *
 * URL: argumento CLI (node scripts/set-webhook.mjs https://...) o env WEBHOOK_URL
 * (el workflow la toma del output webhook_url del root api-gateway).
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

const url = process.argv[2] ?? process.env.WEBHOOK_URL;
if (!url) {
  console.error('No encontré la URL del webhook (argumento o WEBHOOK_URL).');
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

// Menú de comandos (autocompletado al escribir "/" en Telegram). Fuente única,
// compartida con BOT_COMMANDS de src/lib/commands.ts.
const commands = JSON.parse(readFileSync(new URL('../src/lib/bot-commands.json', import.meta.url), 'utf8'));

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
