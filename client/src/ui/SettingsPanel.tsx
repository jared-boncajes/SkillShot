import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type Quality } from '../settings';
import { useStore } from '../store';
import { Btn } from './common';
import { Crosshair } from './Crosshair';

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="field-value">{format ? format(value) : value}</span>
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <button type="button" className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)} aria-pressed={value}><span /></button>
      <span className="field-value">{value ? 'On' : 'Off'}</span>
    </label>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const fn = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', fn);
    return () => document.removeEventListener('fullscreenchange', fn);
  }, []);
  const xh = settings.crosshair;
  const setXh = (p: Partial<typeof xh>) => setSettings({ crosshair: { ...xh, ...p } });

  return (
    <div className="settings">
      <section>
        <h3>Controls</h3>
        <Slider label="Mouse sensitivity" value={settings.sensitivity} min={0.2} max={8} step={0.05} onChange={(v) => setSettings({ sensitivity: v })} format={(v) => v.toFixed(2)} />
        <Slider label="Field of view" value={settings.fov} min={80} max={120} step={1} onChange={(v) => setSettings({ fov: v })} format={(v) => `${v}°`} />
        <Toggle label="Weapon bobbing" value={settings.viewBob} onChange={(v) => setSettings({ viewBob: v })} />
        <p className="hint">Sensitivity matches the Source convention (0.022° per count × value). Bobbing only moves the weapon model, never your aim.</p>
      </section>
      <section>
        <h3>Audio</h3>
        <Slider label="Master volume" value={settings.master} min={0} max={1} step={0.01} onChange={(v) => setSettings({ master: v })} format={pct} />
        <Slider label="Sound effects" value={settings.sfx} min={0} max={1} step={0.01} onChange={(v) => setSettings({ sfx: v })} format={pct} />
        <Slider label="Music" value={settings.music} min={0} max={1} step={0.01} onChange={(v) => setSettings({ music: v })} format={pct} />
      </section>
      <section>
        <h3>Video</h3>
        <label className="field">
          <span className="field-label">Graphics quality</span>
          <div className="segmented">
            {(['low', 'medium', 'high'] as Quality[]).map((q) => (
              <button key={q} type="button" className={settings.quality === q ? 'on' : ''} onClick={() => setSettings({ quality: q })}>{q}</button>
            ))}
          </div>
          <span className="field-value" />
        </label>
        <Slider label="Resolution scale" value={settings.resScale} min={0.5} max={1} step={0.05} onChange={(v) => setSettings({ resScale: v })} format={pct} />
        <Toggle label="Fullscreen" value={fullscreen} onChange={(v) => { if (v) void document.documentElement.requestFullscreen?.().catch(() => {}); else void document.exitFullscreen?.().catch(() => {}); }} />
        <Toggle label="Show frame rate" value={settings.showFps} onChange={(v) => setSettings({ showFps: v })} />
        <p className="hint">Low disables shadows; high uses soft 2K shadows. Anti-aliasing changes apply from the next match.</p>
      </section>
      <section>
        <h3>Crosshair</h3>
        <div className="xh-row">
          <div className="xh-preview"><Crosshair preview /></div>
          <div className="xh-fields">
            <label className="field">
              <span className="field-label">Colour</span>
              <input type="color" value={xh.color} onChange={(e) => setXh({ color: e.target.value })} />
              <span className="field-value">{xh.color}</span>
            </label>
            <Slider label="Length" value={xh.size} min={0} max={20} step={1} onChange={(v) => setXh({ size: v })} />
            <Slider label="Gap" value={xh.gap} min={0} max={16} step={1} onChange={(v) => setXh({ gap: v })} />
            <Slider label="Thickness" value={xh.thickness} min={1} max={6} step={1} onChange={(v) => setXh({ thickness: v })} />
            <Toggle label="Centre dot" value={xh.dot} onChange={(v) => setXh({ dot: v })} />
            <Toggle label="Outline" value={xh.outline} onChange={(v) => setXh({ outline: v })} />
            <Toggle label="Show movement inaccuracy" value={xh.dynamic} onChange={(v) => setXh({ dynamic: v })} />
          </div>
        </div>
      </section>
      <div className="row end">
        <Btn variant="ghost" onClick={() => setSettings(structuredClone(DEFAULT_SETTINGS))}>Reset to defaults</Btn>
      </div>
    </div>
  );
}
