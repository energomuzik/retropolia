import { type ReactNode, type ButtonHTMLAttributes } from 'react';
import { sfx } from './sound';
import { useApp } from './store';

/* ---------- пиксельные иконки (inline SVG) ---------- */

function Pix({ p, size = 16, className }: { p: string[]; size?: number; className?: string }) {
  const h = p.length;
  const w = p[0]?.length ?? 0;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={size} height={size} className={className} shapeRendering="crispEdges" aria-hidden>
      {p.flatMap((row, y) =>
        [...row].map((ch, x) =>
          ch === '1' ? <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill="currentColor" /> : null,
        ),
      )}
    </svg>
  );
}

export const Ic = {
  dice: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '.111111111.',
      '1.........1',
      '1..1...1..1',
      '1.........1',
      '1....1....1',
      '1.........1',
      '1..1...1..1',
      '1.........1',
      '.111111111.',
    ]} />
  ),
  map: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '1..1..1..1..1',
      '11.11.11.11.1',
      '1.1.1.1.1.1.1',
      '1.1.1.1.1.1.1',
      '1.1.1.1.1.1.1',
      '1.1.1.1.1.1.1',
      '1.1.1.1.1.1.1',
      '11.11.11.11.1',
      '1..1..1..1..1',
    ]} />
  ),
  grid: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '1111.1111.1111',
      '1111.1111.1111',
      '............',
      '1111.1111.1111',
      '1111.1111.1111',
      '............',
      '1111.1111.1111',
      '1111.1111.1111',
    ]} />
  ),
  cart: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '111111111111',
      '1..........1',
      '1.11111111.1',
      '1.1......1.1',
      '1.1......1.1',
      '1.11111111.1',
      '1..........1',
      '1.11.11.11.1',
      '111111111111',
    ]} />
  ),
  chip: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '.1..1..1..1.',
      '..11111111..',
      '.11......11.',
      '1.1.1111.1.1',
      '1.1.1..1.1.1',
      '1.1.1111.1.1',
      '.11......11.',
      '..11111111..',
      '.1..1..1..1.',
    ]} />
  ),
  gear: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '..1...1...1..',
      '..11..1..11..',
      '...1111111...',
      '..111...111..',
      '.111.....111.',
      '.11..111..11.',
      '.11..111..11.',
      '.111.....111.',
      '..111...111..',
      '...1111111...',
      '..11..1..11..',
      '..1...1...1..',
    ]} />
  ),
  trash: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '...111111...',
      '.1111111111.',
      '..1......1..',
      '..1.1111.1..',
      '..1.1..1.1..',
      '..1.1..1.1..',
      '..1.1111.1..',
      '..1......1..',
      '...111111...',
    ]} />
  ),
  rotate: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '...111111...',
      '..1......1..',
      '.1........1.',
      '.1........1.',
      '1.....11111.',
      '1.........1.',
      '.1........1.',
      '..1......1..',
      '...111111...',
      '......1.....',
      '.....111....',
    ]} />
  ),
  upload: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '.....11.....',
      '....1111....',
      '...111111...',
      '..11111111..',
      '.....11.....',
      '.....11.....',
      '111111111111',
      '1..........1',
      '111111111111',
    ]} />
  ),
  download: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '.....11.....',
      '.....11.....',
      '.....11.....',
      '.....11.....',
      '..11111111..',
      '...111111...',
      '....1111....',
      '111111111111',
      '1..........1',
      '111111111111',
    ]} />
  ),
  play: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '11........',
      '1111......',
      '111111....',
      '11111111..',
      '1111111111',
      '11111111..',
      '111111....',
      '1111......',
      '11........',
    ]} />
  ),
  pause: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '1111..1111',
      '1111..1111',
      '1111..1111',
      '1111..1111',
      '1111..1111',
      '1111..1111',
      '1111..1111',
      '1111..1111',
    ]} />
  ),
  eye: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '...111111...',
      '.11......11.',
      '1....11....1',
      '1...1111...1',
      '1...1111...1',
      '1....11....1',
      '.11......11.',
      '...111111...',
    ]} />
  ),
  trophy: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '111111111111',
      '1.11111111.1',
      '1.11111111.1',
      '11.111111.11',
      '..11111111..',
      '...111111...',
      '....1111....',
      '.....11.....',
      '....1111....',
      '...111111...',
      '..11111111..',
    ]} />
  ),
  clock: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '...111111...',
      '.11......11.',
      '1....1.....1',
      '1....1.....1',
      '1....1111..1',
      '1..........1',
      '1..........1',
      '.11......11.',
      '...111111...',
    ]} />
  ),
  target: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '...111111...',
      '.11......11.',
      '1...1111...1',
      '1..1....1..1',
      '1..1.11.1..1',
      '1..1.11.1..1',
      '1..1....1..1',
      '1...1111...1',
      '.11......11.',
      '...111111...',
    ]} />
  ),
  star: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '.....11.....',
      '.....11.....',
      '....1111....',
      '111111111111',
      '.1111111111.',
      '..11111111..',
      '...111111...',
      '..11111111..',
      '.111....111.',
      '.11......11.',
    ]} />
  ),
  skull: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '...111111...',
      '.1111111111.',
      '.1111111111.',
      '.11.1111.11.',
      '.11.1111.11.',
      '.1111111111.',
      '..111.11.1..',
      '...111111...',
      '...1.11.1...',
      '...111111...',
    ]} />
  ),
  back: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '....11....',
      '...11.....',
      '..11......',
      '.111111111',
      '1111111111',
      '.111111111',
      '..11......',
      '...11.....',
      '....11....',
    ]} />
  ),
  users: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '..111...111..',
      '.11111.11111.',
      '.11111.11111.',
      '..111...111..',
      '.11111.11111.',
      '1111111111111',
      '1111111111111',
      '1111111111111',
    ]} />
  ),
  save: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '11111111111.',
      '1..1111111.1',
      '1..1111111.1',
      '1..1111111.1',
      '1..........1',
      '1.11111111.1',
      '1.1......1.1',
      '1.1......1.1',
      '1.11111111.1',
      '111111111111',
    ]} />
  ),
  globe: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '...111111...',
      '.11.1111.11.',
      '1.1.1..1.1.1',
      '1.11....11.1',
      '111111111111',
      '1.11....11.1',
      '1.1.1..1.1.1',
      '.11.1111.11.',
      '...111111...',
    ]} />
  ),
  check: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '........11',
      '.......111',
      '......111.',
      '11...111..',
      '111.111...',
      '.111111...',
      '..1111....',
      '...11.....',
    ]} />
  ),
  cross: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '11......11',
      '111....111',
      '.111..111.',
      '..111111..',
      '...1111...',
      '..111111..',
      '.111..111.',
      '111....111',
      '11......11',
    ]} />
  ),
  bolt: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '....11111',
      '...1111..',
      '..1111...',
      '.1111111.',
      '...1111..',
      '..1111...',
      '.1111....',
      '.111.....',
      '.11......',
      '.1.......',
    ]} />
  ),
  home: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '.....11.....',
      '....1111....',
      '...111111...',
      '..11111111..',
      '.1111111111.',
      '111111111111',
      '..11111111..',
      '..111..111..',
      '..111..111..',
      '..11111111..',
    ]} />
  ),
  pawn: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '....111....',
      '...11111...',
      '...11111...',
      '....111....',
      '...11111...',
      '..1111111..',
      '..1111111..',
      '.111111111.',
      '.111111111.',
      '11111111111',
    ]} />
  ),
  plus: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '....11....',
      '....11....',
      '....11....',
      '1111111111',
      '1111111111',
      '....11....',
      '....11....',
      '....11....',
    ]} />
  ),
  pen: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '.......11',
      '......111',
      '.....1111',
      '....1111.',
      '...1111..',
      '..1111...',
      '.1111....',
      '.111.....',
      '11.......',
      '1........',
    ]} />
  ),
  volume: (s = 16, c?: string) => (
    <Pix size={s} className={c} p={[
      '....1.....',
      '...11.1...',
      '..111..1..',
      '11111..1..',
      '11111..1.1',
      '11111..1.1',
      '11111..1..',
      '..111..1..',
      '...11.1...',
      '....1.....',
    ]} />
  ),
};

/* ---------- кнопки / панели ---------- */

type PxProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  color?: 'gold' | 'teal' | 'coral' | 'sky' | 'dim' | 'lime' | 'magma';
  big?: boolean;
  small?: boolean;
};

export function PxBtn({ color = 'gold', big, small, className = '', onClick, children, ...rest }: PxProps) {
  return (
    <button
      {...rest}
      onClick={(e) => { sfx.click(); onClick?.(e); }}
      className={`btn-px pixel-corners btn-${color} inline-flex items-center justify-center gap-2 ${big ? 'px-8 py-4 text-lg' : small ? 'px-3 py-1.5 text-[11px]' : 'px-5 py-2.5 text-sm'} ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostBtn({ className = '', onClick, children, small, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { small?: boolean }) {
  return (
    <button
      {...rest}
      onClick={(e) => { sfx.click(); onClick?.(e); }}
      className={`btn-ghost pixel-corners ${small ? 'px-2.5 py-1 text-[11px]' : 'px-4 py-2 text-xs'} inline-flex items-center justify-center gap-2 ${className}`}
    >
      {children}
    </button>
  );
}

export function Panel({ title, icon, children, className = '', accent = 'var(--color-gold)', right }: {
  title?: ReactNode; icon?: ReactNode; children: ReactNode; className?: string; accent?: string; right?: ReactNode;
}) {
  return (
    <div className={`pixel-panel pixel-corners ${className}`}>
      {title !== undefined && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b-[3px] border-edge bg-[rgba(0,0,0,0.25)]">
          <span style={{ color: accent }} className="shrink-0">{icon}</span>
          <div className="font-display uppercase tracking-wider text-sm" style={{ color: accent }}>{title}</div>
          <div className="ml-auto">{right}</div>
        </div>
      )}
      {children}
    </div>
  );
}

export function Modal({ title, icon, onClose, children, w = 'max-w-2xl', locked }: {
  title: ReactNode; icon?: ReactNode; onClose?: () => void; children: ReactNode; w?: string; locked?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-[rgba(4,6,14,0.82)]" onClick={locked ? undefined : onClose} />
      <div className={`relative pixel-panel pixel-corners pop-in w-full ${w} max-h-[92vh] flex flex-col`}>
        <div className="flex items-center gap-3 px-4 py-3 border-b-[3px] border-edge bg-[rgba(0,0,0,0.3)] shrink-0">
          <span className="text-gold">{icon}</span>
          <div className="font-display uppercase tracking-wider text-sm text-paper">{title}</div>
          {!locked && onClose && (
            <button onClick={() => { sfx.click(); onClose(); }} className="ml-auto text-dim hover:text-coral transition-colors cursor-pointer" aria-label="Закрыть">
              {Ic.cross(16)}
            </button>
          )}
        </div>
        <div className="p-4 sm:p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      onClick={() => { sfx.click(); onChange(!checked); }}
      className="flex items-center gap-3 w-full text-left group cursor-pointer py-1"
    >
      <span className={`relative w-12 h-6 shrink-0 border-2 transition-colors ${checked ? 'bg-teal/25 border-teal' : 'bg-[#0d1226] border-edge'}`}>
        <span className={`absolute top-0.5 w-4 h-4 transition-all ${checked ? 'left-6 bg-teal' : 'left-0.5 bg-faint'}`} />
      </span>
      <span>
        <span className="block font-display text-sm uppercase tracking-wide text-paper group-hover:text-gold transition-colors">{label}</span>
        {hint && <span className="block text-[11px] text-dim leading-tight mt-0.5">{hint}</span>}
      </span>
    </button>
  );
}

export function Stepper({ value, onChange, min, max, step = 1, suffix }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="inline-flex items-center gap-1">
      <GhostBtn small onClick={() => onChange(clamp(value - step))} aria-label="меньше">−</GhostBtn>
      <span className="font-display text-sm text-gold min-w-[52px] text-center tabular-nums">{value}{suffix}</span>
      <GhostBtn small onClick={() => onChange(clamp(value + step))} aria-label="больше">+</GhostBtn>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="tick-label block mb-1.5">{label}</span>
      {children}
    </label>
  );
}

export function Toasts({ items }: { items: { id: number; text: string; kind: string }[] }) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[95] flex flex-col gap-2 items-center pointer-events-none">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pixel-panel pixel-corners slide-up px-5 py-2.5 font-display text-xs uppercase tracking-wide ${
            t.kind === 'err' ? 'text-coral border-coral' : t.kind === 'ok' ? 'text-teal border-teal' : 'text-gold'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

/**
 * Полоска громкости эмулятора — постоянный элемент окна эмулятора (вместо
 * спрятанной встроенной панели EmulatorJS). Меняет опции на лету: SegaBox
 * доставляет их в работающее ядро сообщением set-volume (NES и SEGA).
 */
export function EmuVolumeChip({ className }: { className?: string }) {
  const emuSound = useApp((s) => s.options.emuSound);
  const emuVolume = useApp((s) => s.options.emuVolume ?? 1);
  const setOptions = useApp((s) => s.setOptions);
  const shown = emuSound ? emuVolume : 0;
  return (
    <div className={`hud-chip pixel-corners px-3 py-2 ${className ?? ''}`}>
      <div className="flex items-center gap-2">
        <span className={`shrink-0 ${shown > 0 ? 'text-gold' : 'text-faint'}`}>{Ic.volume(13)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={shown}
          onChange={(e) => {
            const v = Number(e.target.value);
            setOptions(emuSound ? { emuVolume: v } : { emuSound: true, emuVolume: v });
          }}
          className="w-full"
          aria-label="Громкость эмулятора"
        />
      </div>
      <div className="tick-label text-faint mt-1">ЗВУК ЭМУЛЯТОРА · {Math.round(shown * 100)}%</div>
    </div>
  );
}
