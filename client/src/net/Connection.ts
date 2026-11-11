import { PROTOCOL_VERSION, WS_PATH, type C2S, type S2C } from '@aimstrike/shared';
import { useStore } from '../store';

/**
 * Resolves the game server URL.
 *  - VITE_SERVER_URL (build-time) points a separately hosted frontend at its backend.
 *  - Otherwise the client talks to its own origin (single-service deploys, and the dev proxy).
 * Pages served over https always use wss.
 */
export function serverUrl(): string {
  const configured = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim();
  if (configured) {
    let url = configured.replace(/^http/i, 'ws').replace(/\/+$/, '');
    if (!/^wss?:\/\//i.test(url)) url = `wss://${url}`;
    if (location.protocol === 'https:') url = url.replace(/^ws:/i, 'wss:');
    return url.endsWith(WS_PATH) ? url : url + WS_PATH;
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
}

const TOKEN_KEY = 'aimstrike.session';

/** WebSocket wrapper with automatic reconnection, session resume and latency measurement. */
export class Connection {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private everOnline = false;
  rtt = 0;
  /** App-level handler (lobby, errors, match flow). */
  onMessage: (msg: S2C) => void = () => {};
  /** Hot-path handler owned by the running Game. */
  gameSink: ((msg: S2C) => void) | null = null;

  connect(): void {
    if (this.ws) return;
    const store = useStore.getState();
    store.set({ conn: this.everOnline ? 'reconnecting' : 'connecting' });
    let ws: WebSocket;
    try {
      ws = new WebSocket(serverUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      let token: string | undefined;
      try { token = sessionStorage.getItem(TOKEN_KEY) || undefined; } catch { /* ignore */ }
      this.send({ t: 'hello', v: PROTOCOL_VERSION, name: useStore.getState().name || 'Player', token });
    };
    ws.onmessage = (ev) => {
      let msg: S2C;
      try { msg = JSON.parse(ev.data as string) as S2C; } catch { return; }
      switch (msg.t) {
        case 's': case 'shot': case 'hit': case 'dmg':
          this.gameSink?.(msg);
          return;
        case 'pong':
          this.rtt = this.rtt === 0 ? performance.now() - msg.c : this.rtt * 0.7 + (performance.now() - msg.c) * 0.3;
          useStore.getState().set({ ping: Math.round(this.rtt) });
          return;
        case 'welcome':
          this.attempts = 0;
          this.everOnline = true;
          try { sessionStorage.setItem(TOKEN_KEY, msg.token); } catch { /* ignore */ }
          useStore.getState().set({ conn: 'online' });
          break;
        case 'kill': case 'match':
          this.gameSink?.(msg);
          break;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      window.clearInterval(this.pingTimer);
      useStore.getState().set({ conn: this.everOnline ? 'reconnecting' : 'connecting' });
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now(), rtt: this.rtt }), 1000);
  }

  private scheduleRetry(): void {
    window.clearTimeout(this.retryTimer);
    // Exponential backoff: 0.5s, 1s, 2s, 4s, then every 5s.
    const delay = Math.min(5000, 500 * 2 ** this.attempts++);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: C2S): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Sends a request that needs a live connection, telling the player when there is none. */
  request(msg: C2S): void {
    if (!this.send(msg)) useStore.getState().showToast('Not connected to the game server yet. Retrying…');
  }
}

export const net = new Connection();
