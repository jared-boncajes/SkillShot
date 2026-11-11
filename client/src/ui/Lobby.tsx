import { useState } from 'react';
import { MAP_LIST, MAPS, MODE_LIST, MODES, WEAPONS, type LobbyMember, type Team } from '@aimstrike/shared';
import { audio } from '../game/Audio';
import { net } from '../net/Connection';
import { useStore } from '../store';
import { Btn, WeaponCard } from './common';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to the legacy command.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function MemberRow({ m, hostId, myId }: { m: LobbyMember; hostId: string; myId: string }) {
  return (
    <li className={`member ${m.connected ? '' : 'offline'} ${m.id === myId ? 'me' : ''}`}>
      <span className="member-name">{m.name}{m.id === hostId && <em className="tag host">HOST</em>}{m.id === myId && <em className="tag">YOU</em>}</span>
      <span className="member-weapon">{WEAPONS[m.weapon].name}</span>
      <span className="member-ping">{m.connected ? `${m.ping} ms` : 'reconnecting…'}</span>
      <span className={`member-ready ${m.ready || m.id === hostId ? 'yes' : ''}`}>{m.id === hostId ? 'Host' : m.ready ? 'Ready' : 'Not ready'}</span>
    </li>
  );
}

export function LobbyScreen() {
  const lobby = useStore((s) => s.lobby)!;
  const myId = useStore((s) => s.myId);
  const showToast = useStore((s) => s.showToast);
  const [copied, setCopied] = useState(false);
  const me = lobby.members.find((m) => m.id === myId);
  const isHost = lobby.hostId === myId;
  const inLobby = lobby.phase === 'lobby';
  const mode = MODES[lobby.settings.modeId];
  const capacity = lobby.settings.teamSize * 2;
  const others = lobby.members.filter((m) => m.id !== lobby.hostId && m.connected);
  const allReady = others.every((m) => m.ready);

  const copy = async () => {
    if (await copyText(lobby.code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else showToast('Could not copy automatically — select the code and copy it manually.');
  };
  const setting = (settings: Record<string, unknown>) => net.request({ t: 'settings', settings });

  const teamColumn = (team: Team) => {
    const list = lobby.members.filter((m) => m.team === team);
    return (
      <div className={`team team-${team}`}>
        <div className="team-head">
          <h3>{mode.teamBased ? (team === 'red' ? 'Red Team' : 'Blue Team') : team === 'red' ? 'Group A' : 'Group B'}</h3>
          <span>{list.length}/{lobby.settings.teamSize}</span>
        </div>
        <ul>
          {list.map((m) => <MemberRow key={m.id} m={m} hostId={lobby.hostId} myId={myId} />)}
          {Array.from({ length: Math.max(0, lobby.settings.teamSize - list.length) }, (_, i) => <li key={`e${i}`} className="member empty">Open slot</li>)}
        </ul>
        {inLobby && me && me.team !== team && list.length < lobby.settings.teamSize && (
          <Btn variant="ghost" onClick={() => net.request({ t: 'team', team })}>Join {team === 'red' ? 'Red' : 'Blue'}</Btn>
        )}
      </div>
    );
  };

  return (
    <div className="lobby">
      <header className="lobby-head">
        <div>
          <span className="eyebrow">Lobby code</span>
          <div className="code-row">
            <span className="lobby-code" data-testid="lobby-code">{lobby.code}</span>
            <Btn onClick={copy}>{copied ? 'Copied ✓' : 'Copy Code'}</Btn>
          </div>
          <span className="sub">Share this code. Friends choose <b>Join Lobby</b> and type it in. {lobby.members.length}/{capacity} players.</span>
        </div>
        <Btn variant="danger" onClick={() => net.request({ t: 'leave' })}>Leave Lobby</Btn>
      </header>

      <section className="lobby-settings">
        <label>
          <span>Map</span>
          <select disabled={!isHost || !inLobby} value={lobby.settings.mapId} onChange={(e) => setting({ mapId: e.target.value })}>
            {MAP_LIST.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>
          <span>Mode</span>
          <select disabled={!isHost || !inLobby} value={lobby.settings.modeId} onChange={(e) => setting({ modeId: e.target.value })}>
            {MODE_LIST.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>
          <span>Team size</span>
          <select disabled={!isHost || !inLobby} value={lobby.settings.teamSize} onChange={(e) => setting({ teamSize: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} v {n}</option>)}
          </select>
        </label>
        <label>
          <span>Visibility</span>
          <select disabled={!isHost || !inLobby} value={lobby.settings.isPublic ? '1' : '0'} onChange={(e) => setting({ isPublic: e.target.value === '1' })}>
            <option value="0">Private (code only)</option>
            <option value="1">Public (quick match)</option>
          </select>
        </label>
        <p>{MAPS[lobby.settings.mapId].description} {mode.description}{!isHost && ' Only the host can change these.'}</p>
      </section>

      <section className="teams">{teamColumn('red')}{teamColumn('blue')}</section>

      <section>
        <h3>Starting weapon <small>all six are available in the match with keys 1–6</small></h3>
        <div className="weapon-grid">
          {WEAPONS.map((_, i) => <WeaponCard key={i} index={i} selected={me?.weapon === i} onSelect={() => net.request({ t: 'weapon', weapon: i })} />)}
        </div>
      </section>

      <footer className="lobby-foot">
        {!inLobby ? (
          <span className="status">Match in progress…</span>
        ) : isHost ? (
          <>
            <span className="status">{others.length === 0 ? 'Waiting for players to join…' : allReady ? 'Everyone is ready.' : 'Waiting for players to ready up…'}</span>
            <Btn variant="primary" onClick={() => net.request({ t: 'start' })}>Start Match</Btn>
          </>
        ) : (
          <>
            <span className="status">{me?.ready ? 'Waiting for the host to start…' : 'Ready up when you are set.'}</span>
            <Btn variant={me?.ready ? 'default' : 'primary'} onClick={() => { audio.ui('ready'); net.request({ t: 'ready', ready: !me?.ready }); }}>
              {me?.ready ? 'Cancel Ready' : 'Ready'}
            </Btn>
          </>
        )}
      </footer>
    </div>
  );
}
