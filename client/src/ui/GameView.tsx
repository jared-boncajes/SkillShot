import { useEffect, useRef, useState } from 'react';
import { MAPS, MAX_HEALTH, MODES, WEAPONS, type ScoreRow, type Team } from '@aimstrike/shared';
import { audio } from '../game/Audio';
import { Game } from '../game/Game';
import { net } from '../net/Connection';
import { useStore } from '../store';
import { Btn, fmtTime } from './common';
import { Crosshair } from './Crosshair';
import { SettingsPanel } from './SettingsPanel';

/** Re-renders every `ms` so countdowns stay current without touching the store. */
function useNow(ms: number, active = true): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(performance.now()), ms);
    return () => window.clearInterval(t);
  }, [ms, active]);
  return active ? Math.max(now, performance.now() - ms) : now;
}

function TopBar() {
  const hud = useStore((s) => s.hud);
  const match = useStore((s) => s.match)!;
  const rows = useStore((s) => s.rows);
  const myId = useStore((s) => s.myId);
  const mode = MODES[match.modeId];
  const time = hud.live ? hud.timeLeft : Math.ceil(match.remainingMs / 1000);
  if (!mode.teamBased) {
    const mine = rows.find((r) => r.id === myId)?.kills ?? 0;
    const lead = rows[0]?.kills ?? 0;
    return (
      <div className="topbar">
        <div className="score ffa"><span>YOU</span><b>{mine}</b></div>
        <div className="clock"><b>{fmtTime(time)}</b><span>First to {match.scoreLimit}</span></div>
        <div className="score ffa"><b>{lead}</b><span>LEADER</span></div>
      </div>
    );
  }
  return (
    <div className="topbar">
      <div className="score red"><span>RED</span><b data-testid="score-red">{hud.scores[0]}</b></div>
      <div className="clock"><b>{fmtTime(time)}</b><span>First to {match.scoreLimit}</span></div>
      <div className="score blue"><b data-testid="score-blue">{hud.scores[1]}</b><span>BLUE</span></div>
    </div>
  );
}

function Vitals() {
  const hud = useStore((s) => s.hud);
  const w = WEAPONS[hud.weapon];
  const low = hud.mag <= Math.ceil(w.magSize * 0.25);
  return (
    <>
      <div className={`health ${hud.hp <= 30 ? 'low' : ''}`}>
        <span className="health-num" data-testid="hp">{hud.alive ? hud.hp : 0}</span>
        <div className="health-bar"><div style={{ width: `${hud.alive ? (hud.hp / MAX_HEALTH) * 100 : 0}%` }} /></div>
        <span className="health-label">HEALTH{hud.protected && <em> · SPAWN PROTECTED</em>}</span>
      </div>
      <div className="ammo">
        <div className="ammo-count">
          <b className={low ? 'low' : ''} data-testid="mag">{hud.mag}</b><span>/ {hud.reserve}</span>
        </div>
        <div className="ammo-weapon">{w.name}<small>{w.role}</small></div>
        <ol className="slots">
          {WEAPONS.map((x, i) => <li key={x.id} className={i === hud.weapon ? 'on' : ''}><kbd>{i + 1}</kbd>{x.name.split(' ')[0]}</li>)}
        </ol>
      </div>
      {hud.alive && hud.reloading && <div className="center-note">RELOADING</div>}
      {hud.alive && !hud.reloading && hud.mag === 0 && hud.reserve === 0 && <div className="center-note warn">OUT OF AMMO — SWITCH WEAPON</div>}
    </>
  );
}

function KillFeed() {
  const feed = useStore((s) => s.feed);
  const now = useNow(1000);
  const [born] = useState(() => new Map<number, number>());
  for (const f of feed) if (!born.has(f.n)) born.set(f.n, performance.now());
  return (
    <ul className="feed">
      {feed.filter((f) => now - (born.get(f.n) ?? now) < 6000).map((f) => (
        <li key={f.n} className={f.mine ? 'mine' : ''}>
          <span className={f.killerTeam}>{f.killer}</span>
          <i>{WEAPONS[f.weapon].name}{f.head && <b title="Headshot"> ◎</b>}</i>
          <span className={f.victimTeam}>{f.victim}</span>
        </li>
      ))}
    </ul>
  );
}

function HitMarker() {
  const hm = useStore((s) => s.hitMarker);
  if (hm.n === 0) return null;
  return <div key={hm.n} className={`hitmarker ${hm.head ? 'head' : ''} ${hm.kill ? 'kill' : ''}`}><i /><i /><i /><i /></div>;
}

function DamageIndicator() {
  const dmg = useStore((s) => s.damage);
  if (dmg.n === 0) return null;
  return (
    <div key={dmg.n} className="damage">
      <div className="damage-vignette" />
      <div className="damage-arc" style={{ transform: `rotate(${-dmg.angle}rad)` }}><i /></div>
    </div>
  );
}

function Banner() {
  const banner = useStore((s) => s.banner);
  if (banner.n === 0) return null;
  return <div key={banner.n} className="banner"><b>{banner.text}</b><span>{banner.sub}</span></div>;
}

function NetStats() {
  const ping = useStore((s) => s.ping);
  const fps = useStore((s) => s.fps);
  const conn = useStore((s) => s.conn);
  const showFps = useStore((s) => s.settings.showFps);
  return (
    <div className={`netstats conn-${conn}`}>
      <span><i />{conn === 'online' ? `${ping} ms` : 'RECONNECTING'}</span>
      {showFps && <span data-testid="fps">{fps} FPS</span>}
    </div>
  );
}

function Countdown() {
  const match = useStore((s) => s.match)!;
  const active = match.phase === 'countdown';
  const now = useNow(100, active);
  const left = Math.ceil((match.receivedAt + match.startsInMs - now) / 1000);
  const last = useRef(0);
  useEffect(() => {
    if (active && left !== last.current && left > 0) { last.current = left; audio.countdown(false); }
  }, [left, active]);
  useEffect(() => {
    if (!active && last.current !== 0) { last.current = 0; audio.countdown(true); }
  }, [active]);
  if (!active) return null;
  return (
    <div className="countdown">
      <span>{MAPS[match.mapId].name} · {MODES[match.modeId].name}</span>
      <b key={left}>{Math.max(1, left)}</b>
      <span>Match starting</span>
    </div>
  );
}

function Respawn() {
  const hud = useStore((s) => s.hud);
  const now = useNow(100, !hud.alive && hud.respawnAt > 0);
  if (hud.alive || hud.respawnAt === 0) return null;
  return <div className="respawn">Respawning in <b>{Math.max(0, (hud.respawnAt - now) / 1000).toFixed(1)}</b></div>;
}

function Table({ rows, team, title, myId }: { rows: ScoreRow[]; team?: Team; title: string; myId: string }) {
  const list = team ? rows.filter((r) => r.team === team) : rows;
  return (
    <div className={`sb-team ${team ?? 'all'}`}>
      <table>
        <thead>
          <tr><th>{title}</th><th>Elims</th><th>Deaths</th><th>HS %</th><th>Accuracy</th><th>Ping</th></tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id} className={`${r.id === myId ? 'me' : ''} ${r.connected ? '' : 'offline'}`}>
              <td>{r.name}{!r.connected && ' (disconnected)'}</td><td>{r.kills}</td><td>{r.deaths}</td><td>{r.hsPct}%</td><td>{r.accPct}%</td><td>{r.connected ? r.ping : '—'}</td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={6} className="none">No players</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ScoreTables() {
  const rows = useStore((s) => s.rows);
  const myId = useStore((s) => s.myId);
  const match = useStore((s) => s.match)!;
  const teamBased = MODES[match.modeId].teamBased;
  return teamBased ? (
    <div className="sb-grid"><Table rows={rows} team="red" title="Red Team" myId={myId} /><Table rows={rows} team="blue" title="Blue Team" myId={myId} /></div>
  ) : (
    <div className="sb-grid one"><Table rows={rows} title="Players" myId={myId} /></div>
  );
}

function Scoreboard() {
  const show = useStore((s) => s.scoreboard);
  const result = useStore((s) => s.result);
  if (!show || result) return null;
  return <div className="overlay scoreboard"><h2>Scoreboard</h2><ScoreTables /></div>;
}

function Results() {
  const result = useStore((s) => s.result);
  const myId = useStore((s) => s.myId);
  const lobby = useStore((s) => s.lobby);
  const now = useNow(250, !!result);
  if (!result) return null;
  const myTeam = lobby?.members.find((m) => m.id === myId)?.team;
  const won = result.winner === myId || result.winner === myTeam;
  const tie = result.winner === 'tie';
  const left = Math.max(0, Math.ceil((result.receivedAt + result.returnInMs - now) / 1000));
  return (
    <div className="overlay results" data-testid="results">
      <span className="eyebrow">{result.reason === 'score' ? 'Score limit reached' : 'Time expired'}</span>
      <h1 className={tie ? 'tie' : won ? 'win' : 'loss'}>{tie ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT'}</h1>
      <p className="winner">{tie ? 'Nobody takes it' : `${result.winnerName} wins`} · <span className="red">{result.scores[0]}</span> – <span className="blue">{result.scores[1]}</span></p>
      <ScoreTables />
      <p className="sub">Returning to the lobby in {left}s…</p>
    </div>
  );
}

function PauseMenu({ onResume }: { onResume: () => void }) {
  const paused = useStore((s) => s.paused);
  const tab = useStore((s) => s.pauseTab);
  const set = useStore((s) => s.set);
  const result = useStore((s) => s.result);
  const loading = useStore((s) => s.loading);
  if (!paused || result || loading) return null;
  return (
    <div className="overlay pause" onMouseDown={(e) => e.stopPropagation()}>
      {tab === 'main' ? (
        <div className="pause-card">
          <h2>Paused</h2>
          <p className="sub">The match keeps running. Click Resume to capture the mouse.</p>
          <Btn variant="primary" data-testid="resume" onClick={onResume}>Resume</Btn>
          <Btn onClick={() => set({ pauseTab: 'settings' })}>Settings</Btn>
          <Btn variant="danger" onClick={() => net.request({ t: 'leave' })}>Leave Match</Btn>
        </div>
      ) : (
        <div className="pause-card wide">
          <div className="panel-head"><Btn variant="ghost" onClick={() => set({ pauseTab: 'main' })}>← Back</Btn><h2>Settings</h2></div>
          <SettingsPanel />
        </div>
      )}
    </div>
  );
}

export function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const mapId = useStore((s) => s.match!.mapId);
  const modeId = useStore((s) => s.match!.modeId);
  const loading = useStore((s) => s.loading);
  const conn = useStore((s) => s.conn);
  const result = useStore((s) => s.result);
  const alive = useStore((s) => s.hud.alive);

  useEffect(() => {
    const s = useStore.getState();
    const game = new Game(canvasRef.current!, s.match!, s.myId);
    gameRef.current = game;
    (window as unknown as { __game?: Game }).__game = game;
    return () => {
      game.dispose();
      gameRef.current = null;
      delete (window as unknown as { __game?: Game }).__game;
      useStore.getState().set({ paused: false, scoreboard: false, loading: false });
    };
  }, [mapId, modeId]);

  // Release the mouse for the results screen.
  useEffect(() => {
    if (result) gameRef.current?.input.unlock();
  }, [result]);

  return (
    <div className="game">
      <canvas ref={canvasRef} className="game-canvas" onClick={() => gameRef.current?.resume()} />
      <div className="hud">
        <TopBar />
        <NetStats />
        <KillFeed />
        {alive && !result && <Crosshair />}
        <HitMarker />
        <DamageIndicator />
        <Banner />
        <Vitals />
        <Respawn />
        <Countdown />
      </div>
      <Scoreboard />
      <PauseMenu onResume={() => gameRef.current?.resume()} />
      <Results />
      {conn !== 'online' && <div className="overlay reconnect"><div className="spinner" /><h2>Connection lost</h2><p>Trying to reconnect — your slot is held for 30 seconds.</p></div>}
      {loading && <div className="overlay loading"><div className="spinner" /><h2>Loading {MAPS[mapId]?.name}</h2><p>Building the arena and syncing with the server…</p></div>}
    </div>
  );
}
