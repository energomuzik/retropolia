/* ---------- v0.68 CODESEARCH: ядро поиска по памяти эмулятора ----------
   Всё работает поверх ЖИВОГО представления памяти ядра (WebAssembly heap):
   SegaBox отдаёт его через SegaApi.getHeap() — iframe с эмулятором того же
   происхождения (srcDoc), поэтому родительское окно читает и пишет байты
   напрямую. Механика повторяет ArtMoney / Cheat Engine:
   1) «Первый поиск» по точному значению (5 жизней) — полный проход по памяти;
   2) значение в игре меняется (жизней стало 4) → «искать среди найденных» —
      фильтрация прошлого списка по новому значению/сравнению;
   3) повторять, пока не останутся 1–3 адреса — это и есть адрес жизней;
   4) адрес можно править (проверка), заморозить и превратить в УСЛОВИЕ ЗАДАНИЯ
      (строка вида RPC1:001AB2C8:u8:eq:3) для редактора заданий.
   Дополнительно режим «неизвестное значение»: снимок памяти, дальше фильтры
   «изменилось/не изменилось/выросло/уменьшилось» — для величин, чьё начальное
   число неизвестно (полоска босса, счётчик открытого оружия и т.п.). */

import type { CodeOp, CodeType, MemCond } from './types';

export const CODE_PREFIX = 'RPC1';

/* ---------- типы значений ---------- */

export const CODE_TYPE_LABEL: Record<CodeType, string> = {
  u8: '1 байт',
  s8: '1 байт знаковый',
  u16: '2 байта',
  s16: '2 байта знаковые',
  u32: '4 байта',
  s32: '4 байта знаковые',
  f32: 'дробное (float)',
};

export const isFloatT = (t: CodeType) => t === 'f32';
export const typeSize = (t: CodeType) => (t === 'u8' || t === 's8' ? 1 : t === 'u16' || t === 's16' ? 2 : 4);

/** Прочитать значение типа t по адресу a (LE). Вне памяти — null. */
export function readAt(heap: Uint8Array, a: number, t: CodeType): number | null {
  if (a < 0 || a + typeSize(t) > heap.length) return null;
  switch (t) {
    case 'u8': return heap[a];
    case 's8': return (heap[a] << 24) >> 24;
    case 'u16': return heap[a] | (heap[a + 1] << 8);
    case 's16': {
      const v = heap[a] | (heap[a + 1] << 8);
      return (v << 16) >> 16;
    }
    case 'u32': return (heap[a] | (heap[a + 1] << 8) | (heap[a + 2] << 16) | (heap[a + 3] << 24)) >>> 0;
    case 's32': return heap[a] | (heap[a + 1] << 8) | (heap[a + 2] << 16) | (heap[a + 3] << 24);
    case 'f32': {
      try {
        const dv = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
        return dv.getFloat32(a + heap.byteOffset, true);
      } catch { return null; }
    }
  }
}

/** Записать значение типа t по адресу a. Возвращает успех. */
export function writeAt(heap: Uint8Array, a: number, t: CodeType, v: number): boolean {
  if (a < 0 || a + typeSize(t) > heap.length) return false;
  try {
    switch (t) {
      case 'u8':
      case 's8':
        heap[a] = v & 0xff;
        return true;
      case 'u16':
      case 's16':
        heap[a] = v & 0xff;
        heap[a + 1] = (v >>> 8) & 0xff;
        return true;
      case 'u32':
      case 's32':
        heap[a] = v & 0xff;
        heap[a + 1] = (v >>> 8) & 0xff;
        heap[a + 2] = (v >>> 16) & 0xff;
        heap[a + 3] = (v >>> 24) & 0xff;
        return true;
      case 'f32': {
        const dv = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
        dv.setFloat32(a + heap.byteOffset, v, true);
        return true;
      }
    }
  } catch { return false; }
  return false;
}

const eqF = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-3 + 1e-6;

/** Равенство с допуском ТОЛЬКО для float; целые сравниваются точно. */
const sameVal = (a: number, b: number, float: boolean) => (float ? eqF(a, b) : a === b);

/** Сравнение по оператору условия. */
export function opOk(cur: number, op: CodeOp, v: number, float: boolean): boolean {
  const eq = sameVal(cur, v, float);
  switch (op) {
    case 'eq': return eq;
    case 'ne': return !eq;
    case 'gt': return cur > v;
    case 'lt': return cur < v;
    case 'ge': return cur > v || eq;
    case 'le': return cur < v || eq;
  }
}

/* ---------- строка условия (для переноса в редактор заданий) ---------- */

const HEX = '0123456789ABCDEF';
export const hex8 = (n: number) => {
  let s = '';
  for (let i = 7; i >= 0; i--) s += HEX[(n >>> (i * 4)) & 0xf];
  return s;
};
export const parseHex = (s: string): number | null => {
  const m = /^0?x?([0-9a-f]+)$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return Number.isFinite(n) && n >= 0 && n <= 0xffffffff ? n : null;
};

/** Условие → строка «RPC1:001AB2C8:u8:eq:3». */
export const formatCond = (c: MemCond) => `${CODE_PREFIX}:${hex8(c.a)}:${c.t}:${c.op}:${c.v}`;

/** Строка → условие (терпит лишние пробелы, 0x-префикс, строчные буквы). */
export function parseCond(s: string): MemCond | null {
  const parts = s.trim().split(/[:|,\s]+/).filter(Boolean);
  if (parts.length < 5 || parts[0].toUpperCase() !== CODE_PREFIX) return null;
  const a = parseHex(parts[1]);
  const t = parts[2].toLowerCase() as CodeType;
  const op = parts[3].toLowerCase() as CodeOp;
  const v = Number(parts[4]);
  if (a === null || !(t in CODE_TYPE_LABEL) || !(['eq', 'ne', 'gt', 'lt', 'ge', 'le'] as CodeOp[]).includes(op) || !Number.isFinite(v)) return null;
  return { a, t, op, v };
}

export const OP_LABEL: Record<CodeOp, string> = { eq: '=', ne: '≠', gt: '>', lt: '<', ge: '≥', le: '≤' };

/** Условие человеческим языком — для редактора заданий и подсказок в игре. */
export const memCondText = (c: MemCond) => `память 0x${hex8(c.a)} (${CODE_TYPE_LABEL[c.t]}) ${OP_LABEL[c.op]} ${c.v}`;

/* ---------- сканер ---------- */

export type FilterKind = 'exact' | 'changed' | 'unchanged' | 'inc' | 'dec';

export interface ScanState {
  t: CodeType;
  /** Явный список адресов-кандидатов; null — «вся память» (после «неизвестного»). */
  addrs: Uint32Array | null;
  /** Значения кандидатов на МОМЕНТ последнего прохода (параллельны addrs). */
  vals: Float64Array | null;
  /** Снимок всей памяти для режима «неизвестное значение» (пока addrs === null). */
  base: Uint8Array | null;
  baseLen: number;
}

export interface ScanResult {
  addrs: Uint32Array | null;
  vals: Float64Array | null;
  count: number;      // сколько совпало
  overflow: boolean;  // совпадений больше капона — список не сохранён
  scanned: number;    // байт просмотрено
}

/** Превышение — список не ведём, предлагаем сузить поиск. */
export const SCAN_CAP = 1_500_000;

const matchVal = (cur: number, kind: FilterKind, ref: number, v: number, float: boolean): boolean => {
  switch (kind) {
    case 'exact': return sameVal(cur, v, float);
    case 'changed': return !sameVal(cur, ref, float);
    case 'unchanged': return sameVal(cur, ref, float);
    case 'inc': return cur > ref;
    case 'dec': return cur < ref;
  }
};

/**
 * Проход поиска. kind='exact' — точное значение v; остальные сравнивают текущее
 * значение с прошлым (для явного списка — vals, для «неизвестного» — снимок base).
 * Сканирование идёт ЧАНКАМИ с yield через setTimeout, чтобы страница не подвисала:
 * игра продолжает крутиться, значения меняются на глазах — это и нужно для фильтров.
 * st === null — ПЕРВЫЙ проход: для 'exact' это полный поиск, для остальных —
 * снимок памяти («неизвестное значение», кандидаты = вся память).
 */
export async function runScan(
  getHeap: () => Uint8Array | null,
  st: ScanState | null,
  t: CodeType,
  kind: FilterKind,
  v: number,
  onChunk?: (done: number, total: number) => void,
): Promise<{ result: ScanResult; state: ScanState }> {
  const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));
  const float = isFloatT(t);
  const sz = typeSize(t);
  const CHUNK = 8 * 1024 * 1024;

  let heap = getHeap();
  if (!heap || heap.length < sz) throw new Error('Память ядра ещё не готова — дайте игре запуститься');

  // Первый проход «неизвестного значения»: снимок всей памяти, кандидаты — вся память.
  if (!st && kind !== 'exact') {
    const base = heap.slice(0);
    onChunk?.(1, 1);
    await yieldToUi();
    return {
      result: { addrs: null, vals: null, count: base.length, overflow: false, scanned: base.length },
      state: { t, addrs: null, vals: null, base, baseLen: base.length },
    };
  }

  const state: ScanState = st ?? { t, addrs: null, vals: null, base: null, baseLen: 0 };
  const out: number[] = [];
  const valsOut: number[] = [];
  let overflow = false;

  if (state.addrs) {
    // Фильтрация прошлого списка — быстрый путь.
    const total = state.addrs.length;
    for (let i = 0; i < state.addrs.length; i++) {
      if ((i & 0xffff) === 0) { onChunk?.(i, total); await yieldToUi(); heap = getHeap(); if (!heap) throw new Error('Эмулятор перезапустился — повторите поиск'); }
      const a = state.addrs[i];
      const cur = readAt(heap, a, t);
      if (cur === null) continue;
      const ref = state.vals ? state.vals[i] : v;
      if (matchVal(cur, kind, ref, v, float)) {
        if (out.length < SCAN_CAP) { out.push(a); valsOut.push(cur); }
        else overflow = true;
      }
    }
    onChunk?.(total, total);
    const addrs = Uint32Array.from(out);
    const vals = Float64Array.from(valsOut);
    return {
      result: { addrs, vals, count: out.length, overflow, scanned: total },
      state: { t, addrs, vals, base: state.base, baseLen: state.baseLen },
    };
  }

  // Полный проход по памяти (первый точный поиск или фильтр после «неизвестного»).
  const total = heap.length;
  const base = state.base;
  const lim = base ? Math.min(base.length, heap.length) : heap.length;
  for (let a = 0; a + sz <= lim; a++) {
    if ((a & (CHUNK - 1)) === 0 && a > 0) {
      onChunk?.(a, total);
      await yieldToUi();
      heap = getHeap();
      if (!heap) throw new Error('Эмулятор перезапустился — повторите поиск');
    }
    const cur = readAt(heap, a, t);
    if (cur === null) continue;
    if (kind === 'exact') {
      if (!sameVal(cur, v, float)) continue;
    } else if (base) {
      const ref = readAt(base, a, t);
      if (ref === null) continue;
      if (!matchVal(cur, kind, ref, v, float)) continue;
    }
    if (out.length < SCAN_CAP) { out.push(a); valsOut.push(cur); }
    else overflow = true;
  }
  onChunk?.(total, total);
  // Переполнение в цепочке «неизвестного значения»: список не сохраняем, но обновляем
  // снимок — следующий фильтр продолжит сравнение с ЭТОГО момента (как в ArtMoney).
  if (overflow && base) {
    const newBase = heap.slice(0);
    return {
      result: { addrs: null, vals: null, count: out.length, overflow: true, scanned: total },
      state: { t, addrs: null, vals: null, base: newBase, baseLen: newBase.length },
    };
  }
  const addrs = Uint32Array.from(out);
  const vals = Float64Array.from(valsOut);
  return {
    result: { addrs, vals, count: out.length, overflow, scanned: total },
    state: { t, addrs, vals, base: state.base, baseLen: state.baseLen },
  };
}
