import type { Dashboard } from '../../backend/src/lib/miniapp/contract';
import { telegram } from './telegram';

export type { Dashboard };

export type LoadResult =
  | { kind: 'ok'; data: Dashboard; demo: boolean }
  | { kind: 'outside_telegram' }
  | { kind: 'error'; status: number };

export async function loadDashboard(): Promise<LoadResult> {
  const app = telegram();
  if (!app) {
    // Solo en desarrollo local: datos ficticios para ver el diseño. En el
    // build de producción import.meta.env.DEV es false y este bloque (y el
    // módulo demo) no se incluyen.
    if (import.meta.env.DEV) {
      const { demoDashboard } = await import('./demo');
      return { kind: 'ok', data: demoDashboard(), demo: true };
    }
    return { kind: 'outside_telegram' };
  }
  const res = await fetch('/api/dashboard', {
    headers: { 'X-Telegram-Init-Data': app.initData },
    cache: 'no-store',
  });
  if (!res.ok) return { kind: 'error', status: res.status };
  return { kind: 'ok', data: (await res.json()) as Dashboard, demo: false };
}
