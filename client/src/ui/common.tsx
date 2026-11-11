import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { WEAPONS, type WeaponDef } from '@aimstrike/shared';
import { audio } from '../game/Audio';

export function Btn({ variant = 'default', onClick, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) {
  return (
    <button
      {...rest}
      className={`btn btn-${variant} ${rest.className ?? ''}`}
      onMouseEnter={() => audio.ui('hover')}
      onClick={(e) => { audio.unlock(); audio.ui('click'); onClick?.(e); }}
    >
      {children}
    </button>
  );
}

export function Panel({ title, children, wide, onBack }: { title: string; children: ReactNode; wide?: boolean; onBack?: () => void }) {
  return (
    <div className={`panel ${wide ? 'panel-wide' : ''}`}>
      <div className="panel-head">
        {onBack && <Btn variant="ghost" onClick={onBack} aria-label="Back">← Back</Btn>}
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  );
}

export const fmtTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, sec) % 60).padStart(2, '0')}`;

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <div className="stat-track"><div className="stat-fill" style={{ width: `${Math.round(Math.max(0.06, Math.min(1, value)) * 100)}%` }} /></div>
    </div>
  );
}

export function rpm(w: WeaponDef): number {
  if (w.mode === 'burst') return Math.round((w.burstCount * 60) / (w.fireInterval + (w.burstCount - 1) * w.burstInterval));
  return Math.round(60 / w.fireInterval);
}

export function WeaponCard({ index, selected, onSelect, compact }: { index: number; selected?: boolean; onSelect?: () => void; compact?: boolean }) {
  const w = WEAPONS[index];
  return (
    <button
      type="button"
      className={`weapon-card ${selected ? 'selected' : ''} ${compact ? 'compact' : ''}`}
      style={{ ['--accent' as string]: hex(w.visual.accent) }}
      onClick={() => { audio.ui('click'); onSelect?.(); }}
      disabled={!onSelect}
    >
      <div className="weapon-top">
        <span className="weapon-slot">{index + 1}</span>
        <div>
          <div className="weapon-name">{w.name}</div>
          <div className="weapon-role">{w.role} · {w.mode === 'auto' ? 'Full-auto' : w.mode === 'semi' ? 'Semi-auto' : `${w.burstCount}-round burst`}</div>
        </div>
      </div>
      {!compact && (
        <>
          <Bar label="Damage" value={w.damage / 72} />
          <Bar label="Fire rate" value={rpm(w) / 900} />
          <Bar label="Range" value={w.rangeStart / 60} />
          <Bar label="Mobility" value={(w.moveMul - 0.78) / 0.27} />
          <div className="weapon-notes">
            <span className="plus">+ {w.specialty}</span>
            <span className="minus">− {w.tradeoff}</span>
          </div>
          <div className="weapon-meta">{w.magSize} rounds · {w.reloadTime.toFixed(1)}s reload · {w.headMult}× head</div>
        </>
      )}
    </button>
  );
}
