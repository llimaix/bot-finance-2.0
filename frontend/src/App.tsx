import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { loadDashboard } from './api';
import type { LoadResult } from './api';
import { Alert, Lock, Refresh } from './components/Icons';
import { Categorias, Cuentas, Evolucion, GastoDiario, Hero, Kpis, Metas, Movimientos, Tarjetas } from './components/Panels';
import { haptic } from './telegram';

type State = { kind: 'loading' } | LoadResult;

const saludo = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
};

export default function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await loadDashboard());
    } catch {
      setState({ kind: 'error', status: 0 });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    haptic();
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (state.kind === 'loading') return <Skeleton />;
  if (state.kind === 'outside_telegram') {
    return (
      <Message icon={<Lock size={30} />} title="Abre el dashboard desde el bot">
        Por seguridad, esta app solo funciona dentro de Telegram: usa el botón del menú del chat.
      </Message>
    );
  }
  if (state.kind === 'error') {
    const auth = state.status === 401 || state.status === 403;
    return (
      <Message icon={<Alert size={30} />} title={auth ? 'Sesión no válida' : 'No se pudo cargar'}>
        {auth ? 'Cierra y vuelve a abrir el dashboard desde el chat.' : 'Revisa tu conexión e inténtalo de nuevo.'}
        {!auth && (
          <button className="btn" onClick={() => void refresh()}>
            <Refresh size={16} /> Reintentar
          </button>
        )}
      </Message>
    );
  }

  const d = state.data;
  const hora = new Date(d.generadoEn).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });
  return (
    <main className="app">
      <header className="top">
        <div>
          <p className="eyebrow">
            {saludo()}
            {d.usuario ? `, ${d.usuario}` : ''}
          </p>
          <h1>Tus finanzas</h1>
        </div>
        <button className={`icon-btn ${refreshing ? 'spin' : ''}`} onClick={() => void refresh()} aria-label="Actualizar" disabled={refreshing}>
          <Refresh size={20} />
        </button>
      </header>
      {state.demo && <p className="demo">Modo demo · datos ficticios</p>}

      <Hero d={d} />
      <Kpis d={d} />

      <div className="grid">
        <Evolucion d={d} />
        <GastoDiario d={d} />
        <Categorias d={d} />
        <Tarjetas d={d} />
        <Metas d={d} />
        <Cuentas d={d} />
        <Movimientos d={d} />
      </div>

      <footer className="foot">
        Solo lectura · actualizado a las {hora} · los cambios se hacen en el chat
      </footer>
    </main>
  );
}

function Message({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <main className="app center">
      <div className="message">
        <span className="message-icon">{icon}</span>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
    </main>
  );
}

function Skeleton() {
  return (
    <main className="app" aria-busy="true" aria-label="Cargando">
      <div className="sk sk-title" />
      <div className="sk sk-hero" />
      <div className="kpis">
        <div className="sk sk-kpi" />
        <div className="sk sk-kpi" />
        <div className="sk sk-kpi" />
      </div>
      <div className="grid">
        <div className="sk sk-panel span-2" />
        <div className="sk sk-panel" />
        <div className="sk sk-panel" />
      </div>
    </main>
  );
}
