import type { CSSProperties } from 'react';
import { useStore } from '../store';

/** CSS crosshair. In game the gap widens by --xh-spread, which the game loop sets to the real inaccuracy cone. */
export function Crosshair({ preview }: { preview?: boolean }) {
  const xh = useStore((s) => s.settings.crosshair);
  const style = {
    '--xh-color': xh.color,
    '--xh-size': `${xh.size}px`,
    '--xh-gap': `${xh.gap}px`,
    '--xh-thick': `${xh.thickness}px`,
    '--xh-outline': xh.outline ? '0 0 0 1px rgba(0,0,0,0.85)' : 'none',
    '--xh-dyn': xh.dynamic && !preview ? 'var(--xh-spread, 0px)' : '0px',
  } as CSSProperties;
  return (
    <div className={`crosshair ${preview ? 'preview' : ''}`} style={style}>
      {xh.size > 0 && (<><i className="xh-l" /><i className="xh-r" /><i className="xh-t" /><i className="xh-b" /></>)}
      {xh.dot && <i className="xh-dot" />}
    </div>
  );
}
