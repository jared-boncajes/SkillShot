import { useState } from 'react';
import { DAMAGE_MULTIPLIERS, MAP_LIST, MAX_NAME_LENGTH, MODE_LIST, WEAPONS } from '@aimstrike/shared';
import { net } from '../net/Connection';
import { saveName } from '../settings';
import { useStore } from '../store';
import { Btn, Panel, WeaponCard } from './common';
import { SettingsPanel } from './SettingsPanel';

function useName(): [string, (v: string) => void] {
  const name = useStore((s) => s.name);
  const set = useStore((s) => s.set);
  return [name, (v) => { const n = v.slice(0, MAX_NAME_LENGTH); set({ name: n }); saveName(n); }];
}

const playerName = () => useStore.getState().name.trim() || 'Player';

export function MainMenu() {
  const set = useStore((s) => s.set);
  const conn = useStore((s) => s.conn);
  const [name, setName] = useName();
  const offline = conn !== 'online';
  return (
    <div className="main-menu">
      <div className="logo">
        <div className="logo-mark" aria-hidden />
        <h1>AIM<span>STRIKE</span></h1>
        <p>No abilities. No luck. Just aim.</p>
      </div>
      <label className="name-field">
        <span>Callsign</span>
        <input value={name} maxLength={MAX_NAME_LENGTH} placeholder="Enter your name" onChange={(e) => setName(e.target.value)} spellCheck={false} />
      </label>
      <nav className="menu-list">
        <Btn variant="primary" disabled={offline} onClick={() => net.request({ t: 'quick', name: playerName() })}>
          Play<small>Quick match into an open lobby</small>
        </Btn>
        <Btn disabled={offline} onClick={() => set({ screen: 'create' })}>Create Lobby<small>Host a private match and share the code</small></Btn>
        <Btn disabled={offline} onClick={() => set({ screen: 'join' })}>Join Lobby<small>Enter a friend's six-character code</small></Btn>
        <Btn onClick={() => set({ screen: 'settings' })}>Settings</Btn>
        <Btn onClick={() => set({ screen: 'howto' })}>How to Play</Btn>
      </nav>
      {offline && <p className="conn-note">{conn === 'connecting' ? 'Connecting to the game server…' : 'Connection lost — reconnecting…'}</p>}
    </div>
  );
}

export function CreateScreen() {
  const set = useStore((s) => s.set);
  const [mapId, setMapId] = useState(MAP_LIST[0].id);
  const [modeId, setModeId] = useState(MODE_LIST[0].id);
  const [teamSize, setTeamSize] = useState(5);
  const [isPublic, setPublic] = useState(false);
  return (
    <Panel title="Create Lobby" onBack={() => set({ screen: 'menu' })}>
      <h3>Map</h3>
      <div className="choice-grid">
        {MAP_LIST.map((m) => (
          <button key={m.id} type="button" className={`choice ${mapId === m.id ? 'selected' : ''}`} onClick={() => setMapId(m.id)}>
            <strong>{m.name}</strong><span>{m.description}</span>
          </button>
        ))}
      </div>
      <h3>Game mode</h3>
      <div className="choice-grid">
        {MODE_LIST.map((m) => (
          <button key={m.id} type="button" className={`choice ${modeId === m.id ? 'selected' : ''}`} onClick={() => setModeId(m.id)}>
            <strong>{m.name}</strong><span>{m.description}</span>
          </button>
        ))}
      </div>
      <h3>Team size</h3>
      <div className="segmented">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={teamSize === n ? 'on' : ''} onClick={() => setTeamSize(n)}>{n}v{n}</button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
        <span>Public lobby — players pressing <b>Play</b> can be matched into it</span>
      </label>
      <div className="row end">
        <Btn variant="primary" onClick={() => net.request({ t: 'create', name: playerName(), settings: { mapId, modeId, teamSize, isPublic } })}>Create Lobby</Btn>
      </div>
    </Panel>
  );
}

export function JoinScreen() {
  const set = useStore((s) => s.set);
  const [code, setCode] = useState('');
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const submit = () => { if (clean.length === 6) net.request({ t: 'join', name: playerName(), code: clean }); };
  return (
    <Panel title="Join Lobby" onBack={() => set({ screen: 'menu' })}>
      <p className="lead">Ask the host for their six-character lobby code.</p>
      <form className="join-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input
          className="code-input" value={clean} autoFocus placeholder="······" maxLength={6} spellCheck={false} autoComplete="off"
          aria-label="Lobby code" onChange={(e) => setCode(e.target.value)}
        />
        <Btn variant="primary" type="submit" disabled={clean.length !== 6}>Join</Btn>
      </form>
    </Panel>
  );
}

export function SettingsScreen() {
  const set = useStore((s) => s.set);
  return (
    <Panel title="Settings" wide onBack={() => set({ screen: 'menu' })}>
      <SettingsPanel />
    </Panel>
  );
}

const CONTROLS: Array<[string, string]> = [
  ['W A S D', 'Move'], ['Mouse', 'Look and aim'], ['Left mouse', 'Shoot'], ['R', 'Reload'], ['Space', 'Jump'],
  ['Shift', 'Walk (silent, fully accurate)'], ['1 – 6 / Wheel', 'Switch weapon'], ['Tab', 'Scoreboard'], ['Esc', 'Pause / settings'],
];

export function HowToScreen() {
  const set = useStore((s) => s.set);
  return (
    <Panel title="How to Play" wide onBack={() => set({ screen: 'menu' })}>
      <div className="howto">
        <section>
          <h3>Controls</h3>
          <table className="keys"><tbody>{CONTROLS.map(([k, a]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{a}</td></tr>)}</tbody></table>
        </section>
        <section>
          <h3>Winning gunfights</h3>
          <ul className="tips">
            <li><b>Bullets go exactly where the crosshair is.</b> There is no random spread, no aim assist and no critical hits.</li>
            <li><b>Aim for the head.</b> Head {DAMAGE_MULTIPLIERS.head}× · torso {DAMAGE_MULTIPLIERS.torso}× · arms {DAMAGE_MULTIPLIERS.arms}× · legs {DAMAGE_MULTIPLIERS.legs}× · feet {DAMAGE_MULTIPLIERS.feet}×.</li>
            <li><b>Stop or walk to shoot.</b> Standing still or holding Shift is perfectly accurate. Running and jumping open the crosshair — the gap you see is the real inaccuracy.</li>
            <li><b>Learn the recoil.</b> Each weapon climbs in the same fixed pattern every time. Pull down to compensate, or tap and burst.</li>
            <li><b>Range matters.</b> Every weapon loses damage past its effective range; the SMG loses the most, the marksman rifle none.</li>
            <li><b>Listen.</b> Running footsteps and gunfire are positional. Walking is silent.</li>
          </ul>
          <h3>Match rules</h3>
          <ul className="tips">
            <li>Team Deathmatch: Red vs Blue, first to 30 eliminations or the lead after 5 minutes.</li>
            <li>You respawn after a short delay with brief spawn protection, which ends when you fire.</li>
            <li>Everyone has all six weapons and identical movement. Nothing to unlock.</li>
          </ul>
        </section>
        <section className="span">
          <h3>Arsenal</h3>
          <div className="weapon-grid">{WEAPONS.map((_, i) => <WeaponCard key={i} index={i} />)}</div>
        </section>
      </div>
    </Panel>
  );
}
