import type { S2C } from '@aimstrike/shared';
import { audio } from './game/Audio';
import { net } from './net/Connection';
import { INITIAL_HUD, useStore } from './store';

/** Routes server messages that drive menus, lobbies and match flow into the store. */
function onMessage(msg: S2C): void {
  const s = useStore.getState();
  switch (msg.t) {
    case 'welcome':
      if (!msg.resumed && s.lobby) {
        // We were in a lobby, the connection dropped and the slot expired before we got back.
        s.set({ lobby: null, match: null, result: null, screen: 'menu', myId: msg.id });
        s.showToast('Connection was lost and your lobby slot expired. Rejoin with the lobby code.');
      } else {
        s.set({ myId: msg.id });
        if (msg.resumed) s.showToast('Reconnected.', 'info');
      }
      break;
    case 'error':
      s.showToast(msg.message);
      audio.ui('error');
      break;
    case 'lobby': {
      const patch: Parameters<typeof s.set>[0] = { lobby: msg.lobby };
      if (!s.lobby || s.screen !== 'lobby') patch.screen = 'lobby';
      if (msg.lobby.phase === 'lobby' && (s.match || s.result)) {
        // Match over: back to the same lobby.
        patch.match = null;
        patch.result = null;
        patch.rows = [];
        patch.feed = [];
      }
      s.set(patch);
      break;
    }
    case 'left':
      s.set({ lobby: null, match: null, result: null, screen: 'menu', rows: [], feed: [] });
      break;
    case 'match':
      if (!s.match) s.set({ hud: INITIAL_HUD, feed: [], rows: [], result: null });
      useStore.getState().set({ match: { ...msg.match, receivedAt: performance.now() } });
      break;
    case 'score':
      s.set({ rows: msg.rows });
      break;
    case 'end':
      s.set({ result: { ...msg.result, receivedAt: performance.now() }, rows: msg.result.rows });
      break;
  }
}

export function startApp(): void {
  net.onMessage = onMessage;
  net.connect();
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  const s = useStore.getState().settings;
  audio.setVolumes(s.master, s.sfx, s.music);
  useStore.subscribe((st, prev) => {
    if (st.settings !== prev.settings) audio.setVolumes(st.settings.master, st.settings.sfx, st.settings.music);
    if (!!st.match !== !!prev.match) audio.setMusic(!st.match);
  });
  audio.setMusic(true);
}
