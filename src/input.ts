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
  gpad: Record<PadAction, number>; // индекс кнопки W3C-геймпада на каждое действие
  gamepad: boolean;
  smoothing: boolean;
}

export const DEFAULT_GPAD: Record<PadAction, number> = {
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
  A: 0, B: 1, SELECT: 8, START: 9,
};

const PREFS_KEY = 'retropolia-emu-prefs';
export const PREFS_EVENT = 'retropolia-prefs-changed';

export function loadEmuPrefs(): EmuPrefs {
  const base: EmuPrefs = { keys: { ...DEFAULT_KEYS }, gpad: { ...DEFAULT_GPAD }, gamepad: true, smoothing: false };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<EmuPrefs>;
    return {
      keys: { ...base.keys, ...(p.keys ?? {}) },
      gpad: { ...base.gpad, ...(p.gpad ?? {}) },
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
