import { useEffect, useRef, useState } from 'react';
import {
  ACTION_LABELS, PAD_ACTIONS, keyLabel, listGamepads, loadEmuPrefs,
  saveEmuPrefs, DEFAULT_KEYS, DEFAULT_GPAD, DEFAULT_SEGA_KEYS,
  SEGA_ACTIONS, SEGA_ACTION_LABELS,
  type PadAction, type SegaAction, type EmuPrefs,
} from './input';
import { sfx } from './sound';

type Capture = { kind: 'key' | 'gpad'; action: PadAction | SegaAction } | null;

/**
 * Редактор управления: клавиатура (захват по нажатию) и геймпад (захват кнопки).
 * mode='nes'  — раскладка NES (8 кнопок, e.code + геймпад).
 * mode='sega' — раскладка Sega Genesis (A/B/C/X/Y/Z/Start + крест, e.key —
 *               именно их читает ядро EmulatorJS; геймпад настраивает само ядро).
 * Работает «на лету»: сохранили — эмуляторы подхватили без перезапуска.
 */
export default function KeyBinder({ compact = false, mode = 'nes' }: { compact?: boolean; mode?: 'nes' | 'sega' }) {
  const isSega = mode === 'sega';
  const [prefs, setPrefs] = useState<EmuPrefs>(() => loadEmuPrefs());
  const [capture, setCapture] = useState<Capture>(null);
  const [pads, setPads] = useState<Gamepad[]>(() => listGamepads());
  const captureRef = useRef<Capture>(null);
  captureRef.current = capture;

  const update = (p: EmuPrefs) => {
    setPrefs(p);
    saveEmuPrefs(p);
  };

  /* захват клавиши. NES — e.code; SEGA — e.key (нижний регистр, как читает ядро) */
  useEffect(() => {
    if (!capture || capture.kind !== 'key') return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === 'Escape') { setCapture(null); return; }
      if (isSega) {
        const keyName = e.key === ' ' ? 'space' : e.key.toLowerCase();
        update({ ...prefs, segaKeys: { ...prefs.segaKeys, [capture.action as SegaAction]: keyName } });
      } else {
        update({ ...prefs, keys: { ...prefs.keys, [capture.action as PadAction]: e.code } });
      }
      setCapture(null);
      sfx.coin();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, prefs, isSega]);

  /* захват кнопки геймпада + список подключённых (только NES) */
  useEffect(() => {
    const t = setInterval(() => {
      setPads(listGamepads());
      const c = captureRef.current;
      if (!c || c.kind !== 'gpad') return;
      for (const gp of listGamepads()) {
        const bi = gp.buttons.findIndex((b) => b.pressed);
        if (bi >= 0) {
          setPrefs((prev) => {
            const next = { ...prev, gpad: { ...prev.gpad, [c.action as PadAction]: bi } };
            saveEmuPrefs(next);
            return next;
          });
          setCapture(null);
          sfx.coin();
          return;
        }
      }
    }, 80);
    return () => clearInterval(t);
  }, []);

  const reset = () => {
    update({ ...prefs, keys: { ...DEFAULT_KEYS }, gpad: { ...DEFAULT_GPAD }, segaKeys: { ...DEFAULT_SEGA_KEYS } });
    sfx.fail();
  };

  const btnCls = (active: boolean) =>
    `font-pixel text-[9px] px-2 py-1.5 border-2 transition-colors cursor-pointer min-w-[64px] text-center ${
      active ? 'border-magma text-magma blink-hard bg-magma/10' : 'border-edge2 text-paper hover:border-gold hover:text-gold'
    }`;

  /* ---------- SEGA ---------- */
  if (isSega) {
    const label = (k: string) => (k.startsWith('arrow') ? { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }[k] ?? k : k);
    return (
      <div className="space-y-3">
        <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'} gap-2`}>
          {SEGA_ACTIONS.map((a) => (
            <div key={a} className="border-2 border-edge bg-[rgba(0,0,0,0.25)] px-2.5 py-2">
              <div className="tick-label text-faint mb-1.5">{SEGA_ACTION_LABELS[a]}</div>
              <button
                onClick={() => { setCapture({ kind: 'key', action: a }); sfx.hover(); }}
                className={btnCls(capture?.kind === 'key' && capture.action === a)}
                title="Назначить клавишу"
              >
                {capture?.kind === 'key' && capture.action === a ? 'НАЖМИТЕ…' : label(prefs.segaKeys[a])}
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[11px] text-dim max-w-md leading-relaxed">
            Sega Genesis: нижний ряд <span className="text-paper">A B C</span>, верхний <span className="text-paper">X Y Z</span>, крестовина и Start.
            Раскладка применяется сразу — ядро подхватывает её без перезапуска. Геймпад настраивается самим ядром (стандартная раскладка).
          </p>
          <button
            onClick={reset}
            className="btn-ghost pixel-corners px-3 py-1.5 text-[11px] uppercase font-display inline-flex items-center gap-2"
          >
            Сбросить раскладку
          </button>
        </div>
      </div>
    );
  }

  /* ---------- NES ---------- */
  return (
    <div className="space-y-3">
      <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'} gap-2`}>
        {PAD_ACTIONS.map((a) => (
          <div key={a} className="border-2 border-edge bg-[rgba(0,0,0,0.25)] px-2.5 py-2">
            <div className="tick-label text-faint mb-1.5">{ACTION_LABELS[a]}</div>
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => { setCapture({ kind: 'key', action: a }); sfx.hover(); }}
                className={btnCls(capture?.kind === 'key' && capture.action === a)}
                title="Назначить клавишу"
              >
                {capture?.kind === 'key' && capture.action === a ? 'НАЖМИТЕ…' : keyLabel(prefs.keys[a])}
              </button>
              <button
                onClick={() => { setCapture({ kind: 'gpad', action: a }); sfx.hover(); }}
                className={btnCls(capture?.kind === 'gpad' && capture.action === a)}
                title="Назначить кнопку геймпада"
              >
                {capture?.kind === 'gpad' && capture.action === a ? 'КНОПКУ…' : `ДЖОЙ ${prefs.gpad[a]}`}
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-dim max-w-md leading-relaxed">
          Верхняя кнопка — клавиатура, нижняя — геймпад. {compact ? 'Раскладка применяется сразу, прямо во время задания.' : ''}
          {pads.length === 0
            ? ' Геймпад не обнаружен — подключите и нажмите на нём кнопку.'
            : ` Геймпадов подключено: ${pads.length}.`}
        </p>
        <button
          onClick={reset}
          className="btn-ghost pixel-corners px-3 py-1.5 text-[11px] uppercase font-display inline-flex items-center gap-2"
        >
          Сбросить раскладку
        </button>
      </div>
    </div>
  );
}
