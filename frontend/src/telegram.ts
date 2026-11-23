/** Puente mínimo con telegram-web-app.js (cargado en index.html). */
interface TelegramWebApp {
  initData: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  HapticFeedback?: { impactOccurred(style: 'light' | 'medium' | 'heavy'): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const PAGE = '#0d0d0d';

export function telegram(): TelegramWebApp | null {
  const app = window.Telegram?.WebApp;
  return app && app.initData ? app : null;
}

export function initTelegram(): void {
  const app = window.Telegram?.WebApp;
  if (!app) return;
  app.ready();
  app.expand();
  try {
    app.setHeaderColor(PAGE);
    app.setBackgroundColor(PAGE);
  } catch {
    // Clientes antiguos sin estos métodos: se ignora.
  }
}

export function haptic(): void {
  telegram()?.HapticFeedback?.impactOccurred('light');
}
