import { useEffect } from 'react';
import { useStore } from './store';
import { GameView } from './ui/GameView';
import { LobbyScreen } from './ui/Lobby';
import { CreateScreen, HowToScreen, JoinScreen, MainMenu, SettingsScreen } from './ui/Menus';

function Toast() {
  const toast = useStore((s) => s.toast);
  const set = useStore((s) => s.set);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => set({ toast: null }), 4500);
    return () => window.clearTimeout(t);
  }, [toast, set]);
  if (!toast) return null;
  return <div key={toast.n} className={`toast toast-${toast.kind}`} role="alert" onClick={() => set({ toast: null })}>{toast.text}</div>;
}

function ConnBadge() {
  const conn = useStore((s) => s.conn);
  const ping = useStore((s) => s.ping);
  return (
    <div className={`conn conn-${conn}`} data-testid="conn">
      <i />{conn === 'online' ? `Online · ${ping} ms` : conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
    </div>
  );
}

export function App() {
  const screen = useStore((s) => s.screen);
  const match = useStore((s) => s.match);
  const lobby = useStore((s) => s.lobby);

  if (match) {
    return (
      <>
        <GameView />
        <Toast />
      </>
    );
  }
  const view = screen === 'lobby' && !lobby ? 'menu' : screen;
  return (
    <div className="shell">
      <div className="backdrop" aria-hidden />
      <main key={view} className="screen">
        {view === 'menu' && <MainMenu />}
        {view === 'create' && <CreateScreen />}
        {view === 'join' && <JoinScreen />}
        {view === 'settings' && <SettingsScreen />}
        {view === 'howto' && <HowToScreen />}
        {view === 'lobby' && <LobbyScreen />}
      </main>
      <ConnBadge />
      <Toast />
    </div>
  );
}
