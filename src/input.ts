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
  gpadSega: Record<SegaAction, number>; // индекс кнопки W3C-геймпада на каждое действие (SEGA)
  segaKeys: Record<SegaAction, string>; // раскладка SEGA Genesis (значения e.key, нужны ядру EmulatorJS)
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

/* Индексы RetroPad для ядра genesis_plus_gx:
   Genesis A→B(0), B→Y(1), C→A(8), X→X(9), Y→L(10), Z→R(11), Start→3, крест→4..7 */
export const SEGA_TO_RETRO: Partial<Record<SegaAction, number>> = {
  UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  A: 0, B: 1, C: 8, X: 9, Y: 10, Z: 11, START: 3,
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

/* Раскладка геймпада для SEGA Genesis (Megadrive):
   Крестовина 12..15, A=0, B=1, X=2, Y=3, Z=4, C=5, Start=9 */
export const DEFAULT_GPAD_SEGA: Record<SegaAction, number> = {
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  A: 0, B: 1, C: 5, X: 2, Y: 3, Z: 4, START: 9,
};

const PREFS_KEY = 'retropolia-emu-prefs';
export const PREFS_EVENT = 'retropolia-prefs-changed';

export function loadEmuPrefs(): EmuPrefs {
  const base: EmuPrefs = { keys: { ...DEFAULT_KEYS }, gpad: { ...DEFAULT_GPAD }, gpadSega: { ...DEFAULT_GPAD_SEGA }, segaKeys: { ...DEFAULT_SEGA_KEYS }, gamepad: true, smoothing: false };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<EmuPrefs>;
    return {
      keys: { ...base.keys, ...(p.keys ?? {}) },
      gpad: { ...base.gpad, ...(p.gpad ?? {}) },
      gpadSega: { ...base.gpadSega, ...(p.gpadSega ?? {}) },
      segaKeys: { ...base.segaKeys, ...(p.segaKeys ?? {}) },
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
