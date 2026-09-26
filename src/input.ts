import { Controller } from 'jsnes';

export type PadAction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'B' | 'A' | 'SELECT' | 'START';

export const PAD_ACTIONS: PadAction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'B', 'A', 'SELECT', 'START'];

export const ACTION_LABELS: Record<PadAction, string> = {
  UP: 'Вверх', DOWN: 'Вниз', LEFT: 'Влево', RIGHT: 'Вправо',
  B: 'B (красная)', A: 'A (жёлтая)', SELECT: 'Select', START: 'Start',
};

export const ACTION_TO_BTN: Record<PadAction, number> = {
  UP: Controller.BUTTON_UP, DOWN: Controller.BUTTON_DOWN,
  LEFT: Controller.BUTTON_LEFT, RIGHT: Controller.BUTTON_RIGHT,
  B: Controller.BUTTON_B, A: Controller.BUTTON_A,
  SELECT: Controller.BUTTON_SELECT, START: Controller.BUTTON_START,
};

export const DEFAULT_KEYS: Record<PadAction, string> = {
  UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
  B: 'KeyZ', A: 'KeyX', SELECT: 'ShiftLeft', START: 'Enter',
};

export interface EmuPrefs {
  keys: Record<PadAction, string>;
  gpad: Record<PadAction, number>; // индекс кнопки W3C-геймпада на каждое действие (NES)
  segaKeys: Record<SegaAction, string>; // раскладка SEGA Genesis (значения e.key, нужны ядру EmulatorJS)
  segaPad: Record<SegaAction, number>; // индекс кнопки W3C-геймпада на каждое действие (SEGA)
  snesKeys: Record<SnesAction, string>; // раскладка SNES (e.key)
  snesPad: Record<SnesAction, number>;
  gbaKeys: Record<GbaAction, string>; // раскладка Game Boy Advance (e.key)
  gbaPad: Record<GbaAction, number>;
  pceKeys: Record<PceAction, string>; // раскладка PC Engine (e.key)
  pcePad: Record<PceAction, number>;
  a26Keys: Record<A26Action, string>; // раскладка Atari 2600 (e.key)
  a26Pad: Record<A26Action, number>;
  gamepad: boolean;
  smoothing: boolean;
}

/* ---------- SEGA Genesis (Megadrive): 6 кнопок + Start, без Select ---------- */

export type SegaAction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'A' | 'B' | 'C' | 'X' | 'Y' | 'Z' | 'START';

export const SEGA_ACTIONS: SegaAction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'C', 'X', 'Y', 'Z', 'START'];

export const SEGA_ACTION_LABELS: Record<SegaAction, string> = {
  UP: 'Вверх', DOWN: 'Вниз', LEFT: 'Влево', RIGHT: 'Вправо',
  A: 'A', B: 'B', C: 'C', X: 'X', Y: 'Y', Z: 'Z', START: 'Start',
};

export const DEFAULT_SEGA_KEYS: Record<SegaAction, string> = {
  UP: 'arrowup', DOWN: 'arrowdown', LEFT: 'arrowleft', RIGHT: 'arrowright',
  A: 'z', B: 'x', C: 'c', X: 'a', Y: 's', Z: 'd', START: 'enter',
};

/* Индексы RetroPad для ядра genesis_plus_gx. Дефолтная раскладка ЯДРА такова:
   RetroPad B(0)=Genesis B, Y(1)=Genesis A, A(8)=Genesis C,
   X(9)=Genesis Y, L(10)=Genesis X, R(11)=Genesis Z.
   Поэтому чтобы в игре нажалась Genesis-кнопка A — шлём индекс 1 (Y),
   Genesis B — индекс 0 (B), Genesis C — 8 (A), X — 10 (L), Y — 9 (X), Z — 11 (R).
   Start→START(3), крест→4..7. Проверено на Road Rash 3 (газ B, тормоз A). */
export const SEGA_TO_RETRO: Partial<Record<SegaAction, number>> = {
  UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  A: 1, B: 0, C: 8, X: 10, Y: 9, Z: 11, START: 3,
};

export function segaEjsMap(keys: Record<SegaAction, string>): Record<number, string> {
  const out: Record<number, string> = {};
  for (const a of SEGA_ACTIONS) {
    const idx = SEGA_TO_RETRO[a];
    if (idx !== undefined && keys[a]) out[idx] = keys[a];
  }
  return out;
}

/* Индексы RetroPad для ядра nes (fceumm):
   NES A→A(8), B→B(0), Select→2, Start→3, крест→4..7 */
export const NES_TO_RETRO: Partial<Record<PadAction, number>> = {
  UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  B: 0, A: 8, SELECT: 2, START: 3,
};

/* e.code («KeyX», «ArrowUp», «Enter», «ShiftLeft») → e.key в нижнем регистре,
   именно в таком виде клавиши читает ядро EmulatorJS. */
export function codeToEjsKey(code: string): string {
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return code.slice(6);
  switch (code) {
    case 'ArrowUp': return 'arrowup';
    case 'ArrowDown': return 'arrowdown';
    case 'ArrowLeft': return 'arrowleft';
    case 'ArrowRight': return 'arrowright';
    case 'Enter': return 'enter';
    case 'Space': return 'space';
    case 'ShiftLeft':
    case 'ShiftRight': return 'shift';
    case 'ControlLeft':
    case 'ControlRight': return 'control';
    case 'AltLeft':
    case 'AltRight': return 'alt';
    default: return code.toLowerCase();
  }
}

export function nesEjsMap(keys: Record<PadAction, string>): Record<number, string> {
  const out: Record<number, string> = {};
  for (const a of PAD_ACTIONS) {
    const idx = NES_TO_RETRO[a];
    if (idx !== undefined && keys[a]) out[idx] = codeToEjsKey(keys[a]);
  }
  return out;
}

export const DEFAULT_GPAD: Record<PadAction, number> = {
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  A: 0, B: 1, SELECT: 8, START: 9,
};

/* Дефолтная раскладка геймпада для SEGA Genesis (W3C Standard Gamepad):
   A=0 B=1 X=2 Y=3 · L1=4 R1=5 · Select=8 Start=9 · крестовина 12..15.
   Genesis A/B/C — на лицевые A/B/X, X/Y/Z — на Y/L1/R1. Крестовина
   дополнительно дублируется левым стиком (многие падки отдают её только осями). */
export const DEFAULT_SEGA_GPAD: Record<SegaAction, number> = {
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  A: 0, B: 1, C: 2, X: 3, Y: 4, Z: 5, START: 9,
};

/* ---------- SNES (ядро snes9x): 4 лицевые + 2 плечевые ----------
   RetroPad ядра snes9x: B(0), Y(1), Select(2), Start(3), крест(4..7),
   A(8), X(9), L(10), R(11). Клавиши — e.key в нижнем регистре (как SEGA). */
export type SnesAction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'B' | 'A' | 'Y' | 'X' | 'L' | 'R' | 'SELECT' | 'START';

export const SNES_ACTIONS: SnesAction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'B', 'A', 'Y', 'X', 'L', 'R', 'SELECT', 'START'];

export const SNES_ACTION_LABELS: Record<SnesAction, string> = {
  UP: 'Вверх', DOWN: 'Вниз', LEFT: 'Влево', RIGHT: 'Вправо',
  B: 'B', A: 'A', Y: 'Y', X: 'X', L: 'L (плечо)', R: 'R (плечо)', SELECT: 'Select', START: 'Start',
};

export const DEFAULT_SNES_KEYS: Record<SnesAction, string> = {
  UP: 'arrowup', DOWN: 'arrowdown', LEFT: 'arrowleft', RIGHT: 'arrowright',
  B: 'z', A: 'x', Y: 'a', X: 's', L: 'q', R: 'w', SELECT: 'shift', START: 'enter',
};

export const SNES_TO_RETRO: Partial<Record<SnesAction, number>> = {
  UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  B: 0, Y: 1, SELECT: 2, START: 3, A: 8, X: 9, L: 10, R: 11,
};

/* W3C: 0=нижняя (Xbox A), 1=правая (Xbox B), 2=левая (X), 3=верхняя (Y).
   У SNES B — нижняя, A — правая, Y — левая, X — верхняя. */
export const DEFAULT_SNES_GPAD: Record<SnesAction, number> = {
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  B: 0, A: 1, Y: 2, X: 3, L: 4, R: 5, SELECT: 8, START: 9,
};

/* ---------- Game Boy Advance (ядро mgba): B/A + L/R ---------- */
export type GbaAction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'B' | 'A' | 'L' | 'R' | 'SELECT' | 'START';

export const GBA_ACTIONS: GbaAction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'B', 'A', 'L', 'R', 'SELECT', 'START'];

export const GBA_ACTION_LABELS: Record<GbaAction, string> = {
  UP: 'Вверх', DOWN: 'Вниз', LEFT: 'Влево', RIGHT: 'Вправо',
  B: 'B', A: 'A', L: 'L (плечо)', R: 'R (плечо)', SELECT: 'Select', START: 'Start',
};

export const DEFAULT_GBA_KEYS: Record<GbaAction, string> = {
  UP: 'arrowup', DOWN: 'arrowdown', LEFT: 'arrowleft', RIGHT: 'arrowright',
  B: 'z', A: 'x', L: 'q', R: 'w', SELECT: 'shift', START: 'enter',
};

export const GBA_TO_RETRO: Partial<Record<GbaAction, number>> = {
  UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  B: 0, SELECT: 2, START: 3, A: 8, L: 10, R: 11,
};

export const DEFAULT_GBA_GPAD: Record<GbaAction, number> = {
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  B: 0, A: 1, L: 4, R: 5, SELECT: 8, START: 9,
};

/* ---------- PC Engine / TurboGrafx-16 (ядро mednafen_pce): I/II + Run ----------
   RetroPad ядра: II(0), Select(2), Run(3), крест(4..7), I(8).
   Games без BIOS — только HuCard-ромы (.pce); CD-ROM² не поддерживаем. */
export type PceAction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'II' | 'I' | 'SELECT' | 'RUN';

export const PCE_ACTIONS: PceAction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'II', 'I', 'SELECT', 'RUN'];

export const PCE_ACTION_LABELS: Record<PceAction, string> = {
  UP: 'Вверх', DOWN: 'Вниз', LEFT: 'Влево', RIGHT: 'Вправо',
  II: 'II', I: 'I', SELECT: 'Select', RUN: 'Run',
};

export const DEFAULT_PCE_KEYS: Record<PceAction, string> = {
  UP: 'arrowup', DOWN: 'arrowdown', LEFT: 'arrowleft', RIGHT: 'arrowright',
  II: 'z', I: 'x', SELECT: 'shift', RUN: 'enter',
};

export const PCE_TO_RETRO: Partial<Record<PceAction, number>> = {
  UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  II: 0, SELECT: 2, RUN: 3, I: 8,
};

export const DEFAULT_PCE_GPAD: Record<PceAction, number> = {
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  I: 0, II: 1, SELECT: 8, RUN: 9,
};

/* ---------- Atari 2600 (ядро stella2014): одна кнопка огня ----------
   RetroPad ядра: огонь(0), Select(2), Reset(3), джойстик(4..7).
   Однокнопочная консоль: FIRE — главный огонь. */
export type A26Action = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'FIRE' | 'SELECT' | 'RESET';

export const A26_ACTIONS: A26Action[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'FIRE', 'SELECT', 'RESET'];

export const A26_ACTION_LABELS: Record<A26Action, string> = {
  UP: 'Вверх', DOWN: 'Вниз', LEFT: 'Влево', RIGHT: 'Вправо',
  FIRE: 'Огонь', SELECT: 'Select (выбор игры)', RESET: 'Reset (старт)',
};

export const DEFAULT_A26_KEYS: Record<A26Action, string> = {
  UP: 'arrowup', DOWN: 'arrowdown', LEFT: 'arrowleft', RIGHT: 'arrowright',
  FIRE: 'x', SELECT: 'shift', RESET: 'r',
};

export const A26_TO_RETRO: Partial<Record<A26Action, number>> = {
  UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  FIRE: 0, SELECT: 2, RESET: 3,
};

export const DEFAULT_A26_GPAD: Record<A26Action, number> = {
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  FIRE: 0, SELECT: 8, RESET: 9,
};

/* ---------- Семейства раскладок: мост «система рома → набор кнопок» ----------
   Семейство определяет: список действий, подписи, где лежат клавиши/геймпад
   в EmuPrefs и какие RetroPad-индексы получает ядро. NES-семейство общее для
   NES и Game Boy/Color (у gambatte те же индексы, что у fceumm). */
export type PadFamily = 'nes' | 'sega' | 'snes' | 'gba' | 'pce' | 'a26';

export const FAMILY_RETRO: Record<PadFamily, Record<string, number>> = {
  nes: NES_TO_RETRO,
  sega: SEGA_TO_RETRO,
  snes: SNES_TO_RETRO,
  gba: GBA_TO_RETRO,
  pce: PCE_TO_RETRO,
  a26: A26_TO_RETRO,
};

export const FAMILY_GPAD_DEFAULT: Record<PadFamily, Record<string, number>> = {
  nes: DEFAULT_GPAD,
  sega: DEFAULT_SEGA_GPAD,
  snes: DEFAULT_SNES_GPAD,
  gba: DEFAULT_GBA_GPAD,
  pce: DEFAULT_PCE_GPAD,
  a26: DEFAULT_A26_GPAD,
};

export const FAMILY_ACTIONS: Record<PadFamily, readonly string[]> = {
  nes: PAD_ACTIONS,
  sega: SEGA_ACTIONS,
  snes: SNES_ACTIONS,
  gba: GBA_ACTIONS,
  pce: PCE_ACTIONS,
  a26: A26_ACTIONS,
};

export const FAMILY_LABELS: Record<PadFamily, Record<string, string>> = {
  nes: ACTION_LABELS,
  sega: SEGA_ACTION_LABELS,
  snes: SNES_ACTION_LABELS,
  gba: GBA_ACTION_LABELS,
  pce: PCE_ACTION_LABELS,
  a26: A26_ACTION_LABELS,
};

/* Поле EmuPrefs с клавишами/геймпадом семейства (нужно и в iframe, и в UI). */
export const FAMILY_KEYS_FIELD: Record<PadFamily, 'keys' | 'segaKeys' | 'snesKeys' | 'gbaKeys' | 'pceKeys' | 'a26Keys'> = {
  nes: 'keys', sega: 'segaKeys', snes: 'snesKeys', gba: 'gbaKeys', pce: 'pceKeys', a26: 'a26Keys',
};

export const FAMILY_PAD_FIELD: Record<PadFamily, 'gpad' | 'segaPad' | 'snesPad' | 'gbaPad' | 'pcePad' | 'a26Pad'> = {
  nes: 'gpad', sega: 'segaPad', snes: 'snesPad', gba: 'gbaPad', pce: 'pcePad', a26: 'a26Pad',
};

/* NES раскладка хранится как e.code («KeyZ»), остальные — как e.key («z»). */
export const FAMILY_KEY_KIND: Record<PadFamily, 'code' | 'key'> = {
  nes: 'code', sega: 'key', snes: 'key', gba: 'key', pce: 'key', a26: 'key',
};

/** Семейство раскладки по системе рома (r.ext) и/или расширению файла.
 *  Legacy-ромы SEGA хранятся с ext 'sega' — точное расширение добираем из fileName. */
export function padFamilyOf(romExt: string | undefined, fileName?: string): PadFamily {
  let ext = (romExt ?? '').toLowerCase();
  if (ext === 'sega' && fileName) ext = (fileName.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'nes':
    case 'gb':
    case 'gbc':
      return 'nes';
    case 'snes':
    case 'sfc':
    case 'smc':
    case 'fig':
      return 'snes';
    case 'gba':
      return 'gba';
    case 'pce':
      return 'pce';
    case 'a26':
      return 'a26';
    default:
      return 'sega'; // md, gen, bin, sms, gg, 32x, legacy 'sega'
  }
}

/* Подсказка дефолтной клавиатурной раскладки семейства (для экрана задания). */
export const FAMILY_HINT: Record<PadFamily, string> = {
  nes: 'NES · Стрелки · Z=B · X=A · Enter=Start · Shift=Select',
  sega: 'SEGA · Стрелки · Z=A · X=B · C=C · A=X · S=Y · D=Z · Enter=Start',
  snes: 'SNES · Стрелки · Z=B · X=A · A=Y · S=X · Q=L · W=R · Enter=Start · Shift=Select',
  gba: 'GBA · Стрелки · Z=B · X=A · Q=L · W=R · Enter=Start · Shift=Select',
  pce: 'PC ENGINE · Стрелки · Z=II · X=I · Enter=Run · Shift=Select',
  a26: 'ATARI 2600 · Стрелки · X=Огонь · Shift=Select · R=Reset',
};

/* ---------- Метки и пропорции экрана консолей ---------- */
export const CONSOLE_LABELS: Record<string, string> = {
  nes: 'NES',
  sega: 'SEGA',
  md: 'SEGA MD', gen: 'SEGA MD',
  sms: 'SEGA MS', gg: 'SEGA GG',
  '32x': 'SEGA 32X',
  snes: 'SNES',
  gb: 'GAME BOY', gbc: 'GAME BOY COLOR',
  gba: 'GBA',
  a26: 'ATARI 2600',
  pce: 'PC ENGINE',
};

export function consoleLabel(ext: string | undefined): string {
  if (!ext) return 'SEGA';
  return CONSOLE_LABELS[ext.toLowerCase()] ?? ext.toUpperCase();
}

/* Пропорции экрана (ширина/высота) для рамки полного экрана. */
export function consoleAspect(ext: string | undefined): number {
  switch ((ext ?? '').toLowerCase()) {
    case 'nes': return 256 / 240;      // 1.0667
    case 'snes': return 256 / 224;     // 1.1429
    case 'gb':
    case 'gbc': return 160 / 144;      // 1.1111
    case 'gba': return 240 / 160;      // 1.5
    default: return 4 / 3;             // SEGA/PCE/32X/Atari — 1.3333
  }
}

const PREFS_KEY = 'retropolia-emu-prefs';
export const PREFS_EVENT = 'retropolia-prefs-changed';

/* Самовосстановление раскладки: ОДИН физический индекс = ОДНО действие.
   Если в сохранённых настройках несколько действий висят на одной кнопке
   (сбой/старые версии/случайный захват) — первое по порядку оставляет её
   себе, остальные возвращаются на дефолт (если он свободен). Насос в
   SegaBox дополнительно игнорирует дубликаты — двойная страховка. */
function dedupePad<T extends string>(order: T[], pad: Record<T, number>, def: Record<T, number>): Record<T, number> {
  const out = { ...pad };
  const used = new Set<number>();
  for (const a of order) {
    let v = out[a];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) v = def[a];
    if (used.has(v) && !used.has(def[a])) v = def[a];
    out[a] = v;
    used.add(v);
  }
  return out;
}

export function loadEmuPrefs(): EmuPrefs {
  const base: EmuPrefs = {
    keys: { ...DEFAULT_KEYS }, gpad: { ...DEFAULT_GPAD },
    segaKeys: { ...DEFAULT_SEGA_KEYS }, segaPad: { ...DEFAULT_SEGA_GPAD },
    snesKeys: { ...DEFAULT_SNES_KEYS }, snesPad: { ...DEFAULT_SNES_GPAD },
    gbaKeys: { ...DEFAULT_GBA_KEYS }, gbaPad: { ...DEFAULT_GBA_GPAD },
    pceKeys: { ...DEFAULT_PCE_KEYS }, pcePad: { ...DEFAULT_PCE_GPAD },
    a26Keys: { ...DEFAULT_A26_KEYS }, a26Pad: { ...DEFAULT_A26_GPAD },
    gamepad: true, smoothing: false,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<EmuPrefs>;
    return {
      keys: { ...base.keys, ...(p.keys ?? {}) },
      gpad: dedupePad(PAD_ACTIONS, { ...base.gpad, ...(p.gpad ?? {}) }, DEFAULT_GPAD),
      segaKeys: { ...base.segaKeys, ...(p.segaKeys ?? {}) },
      segaPad: dedupePad(SEGA_ACTIONS, { ...base.segaPad, ...(p.segaPad ?? {}) }, DEFAULT_SEGA_GPAD),
      snesKeys: { ...base.snesKeys, ...(p.snesKeys ?? {}) },
      snesPad: dedupePad(SNES_ACTIONS, { ...base.snesPad, ...(p.snesPad ?? {}) }, DEFAULT_SNES_GPAD),
      gbaKeys: { ...base.gbaKeys, ...(p.gbaKeys ?? {}) },
      gbaPad: dedupePad(GBA_ACTIONS, { ...base.gbaPad, ...(p.gbaPad ?? {}) }, DEFAULT_GBA_GPAD),
      pceKeys: { ...base.pceKeys, ...(p.pceKeys ?? {}) },
      pcePad: dedupePad(PCE_ACTIONS, { ...base.pcePad, ...(p.pcePad ?? {}) }, DEFAULT_PCE_GPAD),
      a26Keys: { ...base.a26Keys, ...(p.a26Keys ?? {}) },
      a26Pad: dedupePad(A26_ACTIONS, { ...base.a26Pad, ...(p.a26Pad ?? {}) }, DEFAULT_A26_GPAD),
      gamepad: p.gamepad !== false,
      smoothing: !!p.smoothing,
    };
  } catch {
    return base;
  }
}

export function saveEmuPrefs(p: EmuPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* noop */ }
  window.dispatchEvent(new Event(PREFS_EVENT));
}

const CODE_LABELS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
  Enter: 'Enter', Space: 'Пробел', Tab: 'Tab', Backspace: 'Bksp', Escape: 'Esc',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`', Backslash: '\\',
};

export function keyLabel(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/**
 * Стандартная раскладка геймпада (W3C Standard Gamepad):
 * Xbox: A=0 B=1 X=2 Y=3 · PS: крест=0 круг=1 квадрат=2 треугольник=3.
 * Дублируем: 0 и 3 → A, 1 и 2 → B. Крестовина — кнопки 12..15, Start=9, Select=8.
 */
export const GPAD_BUTTONS: [number, PadAction][] = [
  [12, 'UP'], [13, 'DOWN'], [14, 'LEFT'], [15, 'RIGHT'],
  [0, 'A'], [3, 'A'], [1, 'B'], [2, 'B'],
  [8, 'SELECT'], [9, 'START'],
];

export const GPAD_DEADZONE = 0.45;

export function listGamepads(): Gamepad[] {
  try {
    return Array.from(navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g);
  } catch {
    return [];
  }
}
