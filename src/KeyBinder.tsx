import { useEffect, useRef, useState } from 'react';
import {
  keyLabel, listGamepads, loadEmuPrefs,
  saveEmuPrefs, DEFAULT_KEYS, DEFAULT_GPAD, DEFAULT_SEGA_KEYS, DEFAULT_SEGA_GPAD,
  FAMILY_ACTIONS, FAMILY_LABELS, FAMILY_KEYS_FIELD, FAMILY_PAD_FIELD, FAMILY_KEY_KIND, FAMILY_HINT,
  DEFAULT_SNES_KEYS, DEFAULT_SNES_GPAD, DEFAULT_GBA_KEYS, DEFAULT_GBA_GPAD,
  DEFAULT_PCE_KEYS, DEFAULT_PCE_GPAD, DEFAULT_A26_KEYS, DEFAULT_A26_GPAD,
  type EmuPrefs, type PadFamily,
} from './input';
import { sfx } from './sound';

type Capture = { kind: 'key' | 'gpad'; action: string } | null;

const MODES: PadFamily[] = ['nes', 'sega', 'snes', 'gba', 'pce', 'a26'];

const FAMILY_DEFAULTS: Record<PadFamily, { keys: Record<string, string>; pad: Record<string, number> }> = {
  nes: { keys: DEFAULT_KEYS, pad: DEFAULT_GPAD },
  sega: { keys: DEFAULT_SEGA_KEYS, pad: DEFAULT_SEGA_GPAD },
  snes: { keys: DEFAULT_SNES_KEYS, pad: DEFAULT_SNES_GPAD },
  gba: { keys: DEFAULT_GBA_KEYS, pad: DEFAULT_GBA_GPAD },
  pce: { keys: DEFAULT_PCE_KEYS, pad: DEFAULT_PCE_GPAD },
  a26: { keys: DEFAULT_A26_KEYS, pad: DEFAULT_A26_GPAD },
};

const MODE_TITLES: Record<PadFamily, string> = {
  nes: 'NES', sega: 'SEGA Genesis', snes: 'SNES', gba: 'Game Boy Advance',
  pce: 'PC Engine', a26: 'Atari 2600',
};

/* e.key-значения (нижний регистр) в человекочитаемый вид (SEGA-стиль). */
const EKEY_LABELS: Record<string, string> = {
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  shift: 'Shift', control: 'Ctrl', alt: 'Alt', enter: 'Enter', space: 'Пробел', tab: 'Tab',
};

function ekeyLabel(k: string): string {
  return EKEY_LABELS[k] ?? k;
}

/**
 * Редактор управления: клавиатура (захват по нажатию) и геймпад (захват кнопки).
 * mode — семейство раскладки: 'nes' (NES и Game Boy/Color), 'sega' (Genesis,
 * Master System, Game Gear и 32X), 'snes', 'gba', 'pce', 'a26'.
 * NES хранит e.code, остальные — e.key (нижний регистр, как читает ядро EmulatorJS).
 * Работает «на лету»: сохранили — эмуляторы подхватили без перезапуска.
 */
export default function KeyBinder({ compact = false, mode = 'nes' }: { compact?: boolean; mode?: PadFamily }) {
  const fam: PadFamily = MODES.includes(mode) ? mode : 'nes';
  const isCode = FAMILY_KEY_KIND[fam] === 'code';
  const keysField = FAMILY_KEYS_FIELD[fam];
  const padField = FAMILY_PAD_FIELD[fam];
  const actions = FAMILY_ACTIONS[fam];
  const labels = FAMILY_LABELS[fam];
  const defaults = FAMILY_DEFAULTS[fam];
  const [prefs, setPrefs] = useState<EmuPrefs>(() => loadEmuPrefs());
  const [capture, setCapture] = useState<Capture>(null);
  const [pads, setPads] = useState<Gamepad[]>(() => listGamepads());
  const captureRef = useRef<Capture>(null);
  captureRef.current = capture;

  const update = (p: EmuPrefs) => {
    setPrefs(p);
    saveEmuPrefs(p);
  };

  const keysOf = () => prefs[keysField] as Record<string, string>;
  const padOf = () => prefs[padField] as Record<string, number>;

  /* захват клавиши: NES — e.code; остальные — e.key (нижний регистр, как читает ядро) */
  useEffect(() => {
    if (!capture || capture.kind !== 'key') return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === 'Escape') { setCapture(null); return; }
      if (isCode) {
        update({ ...prefs, [keysField]: { ...keysOf(), [capture.action]: e.code } } as EmuPrefs);
      } else {
        const keyName = e.key === ' ' ? 'space' : e.key.toLowerCase();
        update({ ...prefs, [keysField]: { ...keysOf(), [capture.action]: keyName } } as EmuPrefs);
      }
      setCapture(null);
      sfx.coin();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, prefs, fam]);

  /* захват кнопки геймпада + список подключённых падов.
     Ждём только НОВОЕ нажатие: на старте захвата запоминаем уже зажатые кнопки
     (baseline) и держим паузу ~300 мс — иначе «будящая» кнопка падка (браузер
     видит пад только после первого нажатия) или ещё не отпущенная кнопка
     предыдущего назначения вписывались сами. Порог — value>0.5, чтобы
     полузажатые триггеры не ловились. */
  const gpCapRef = useRef<{ baseline: boolean[]; since: number } | null>(null);
  useEffect(() => {
    if (!capture || capture.kind !== 'gpad') { gpCapRef.current = null; return; }
    const baseline: boolean[] = [];
    for (const gp of listGamepads()) {
      gp.buttons.forEach((b, i) => { if (b.pressed || b.value > 0.5) baseline[i] = true; });
    }
    gpCapRef.current = { baseline, since: Date.now() };
  }, [capture]);
  useEffect(() => {
    const t = setInterval(() => {
      setPads(listGamepads());
      const c = captureRef.current;
      const st = gpCapRef.current;
      if (!c || c.kind !== 'gpad' || !st) return;
      if (Date.now() - st.since < 300) return;
      for (const gp of listGamepads()) {
        const bi = gp.buttons.findIndex((b, i) => !st.baseline[i] && (b.pressed || b.value > 0.5));
        if (bi >= 0) {
          setPrefs((prev) => {
            const next = { ...prev, [padField]: { ...(prev[padField] as Record<string, number>), [c.action]: bi } } as EmuPrefs;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fam]);

  /* сброс ТОЛЬКО текущего семейства (чужие раскладки не трогаем) */
  const reset = () => {
    update({ ...prefs, [keysField]: { ...defaults.keys }, [padField]: { ...defaults.pad } } as EmuPrefs);
    sfx.fail();
  };

  const btnCls = (active: boolean) =>
    `font-pixel text-[9px] px-2 py-1.5 border-2 transition-colors cursor-pointer min-w-[64px] text-center ${
      active ? 'border-magma text-magma blink-hard bg-magma/10' : 'border-edge2 text-paper hover:border-gold hover:text-gold'
    }`;

  return (
    <div className="space-y-3">
      <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'} gap-2`}>
        {actions.map((a) => (
          <div key={a} className="border-2 border-edge bg-[rgba(0,0,0,0.25)] px-2.5 py-2">
            <div className="tick-label text-faint mb-1.5">{labels[a]}</div>
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => { setCapture({ kind: 'key', action: a }); sfx.hover(); }}
                className={btnCls(capture?.kind === 'key' && capture.action === a)}
                title="Назначить клавишу"
              >
                {capture?.kind === 'key' && capture.action === a ? 'НАЖМИТЕ…' : isCode ? keyLabel(keysOf()[a] ?? '') : ekeyLabel(keysOf()[a] ?? '')}
              </button>
              <button
                onClick={() => { setCapture({ kind: 'gpad', action: a }); sfx.hover(); }}
                className={btnCls(capture?.kind === 'gpad' && capture.action === a)}
                title="Назначить кнопку геймпада"
              >
                {capture?.kind === 'gpad' && capture.action === a ? 'КНОПКУ…' : `ДЖОЙ ${padOf()[a] ?? 0}`}
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-dim max-w-md leading-relaxed">
          Верхняя кнопка — клавиатура, нижняя — геймпад. Крестовина падка дублируется левым стиком. {compact ? 'Раскладка применяется сразу, прямо во время задания.' : ''}
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
      {/* подсказка дефолтной раскладки семейства (невидимый носитель данных для тестов/UI) */}
      <span data-family-hint={FAMILY_HINT[fam]} data-family={MODE_TITLES[fam]} className="hidden" />
    </div>
  );
}
