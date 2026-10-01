/* ---------- v0.68/v0.69 CODESEARCH: ядро поиска по памяти эмулятора ----------
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
   v0.69: ПОСЛЕДОВАТЕЛЬНОСТИ (как «пользовательский тип» в ArtMoney) — можно
   искать 2–4 значения ПОДРЯД в памяти (напр. текущее HP и максимум рядом):
   адрес-кандидат — начало цепочки, все позиции должны сравниться.
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

/* v0.69: фильтры «среди найденных» — ПОЛНЫЙ набор: точное значение, операторы
   (= ≠ > < ≥ ≤ — в v0.68 пять операторов были в UI, но тип/свитч их не знали и
   фильтр молча не находил ничего — исправлено) и сравнение с прошлым значением. */
export type FilterKind = 'exact' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | 'changed' | 'unchanged' | 'inc' | 'dec';

export interface ScanState {
  t: CodeType;
  /** v0.69: ширина ПОСЛЕДОВАТЕЛЬНОСТИ — сколько значений подряд ищем (1 = обычный поиск).
      Фиксируется ПЕРВЫМ поиском; фильтры обязаны держать ту же ширину. */
  seqN: number;
  /** Явный список адресов-кандидатов; null — «вся память» (после «неизвестного»). */
  addrs: Uint32Array | null;
  /** Значения кандидатов на МОМЕНТ последнего прохода, ПОЗИЦИЯ ЗА ПОЗИЦИЕЙ:
      vals[i*seqN + p] — прошлое значение p-го элемента цепочки (адрес addrs[i] + p*size(t)). */
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

/**
 * Проход поиска. kind='exact' — точное значение v; остальные сравнивают текущее
 * значение с прошлым (для явного списка — vals, для «неизвестного» — снимок base).
 * v0.69: seq — ЗНАЧЕНИЯ ПОСЛЕДОВАТЕЛЬНОСТИ (2–4 числа, лежащие ПОДРЯД в памяти;
 * один элемент — одно значение типа t): адрес-кандидат — НАЧАЛО цепочки, сравнить
 * нужно КАЖДУЮ позицию; для операторов (= ≠ > < ≥ ≤) позиция p сравнивается со
 * своим seq[p], для «изменилось/не изменилось/выросло/уменьшилось» — со своим
 * прошлым значением. Одиночный поиск = seq из одного элемента (или пустой).
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
  seq: number[] = [],
): Promise<{ result: ScanResult; state: ScanState }> {
  const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));
  const float = isFloatT(t);
  const sz = typeSize(t);
  const CHUNK = 8 * 1024 * 1024;
  /* ширина цепочки фиксируется ПЕРВЫМ поиском; на фильтрах берём её из состояния */
  const seqN = st ? st.seqN : Math.max(1, Math.min(4, seq.length || 1));

  let heap = getHeap();
  if (!heap || heap.length < sz) throw new Error('Память ядра ещё не готова — дайте игре запуститься');

  // Первый проход «неизвестного значения»: снимок всей памяти, кандидаты — вся память.
  if (!st && kind !== 'exact') {
    const base = heap.slice(0);
    onChunk?.(1, 1);
    await yieldToUi();
    return {
      result: { addrs: null, vals: null, count: base.length, overflow: false, scanned: base.length },
      state: { t, seqN, addrs: null, vals: null, base, baseLen: base.length },
    };
  }

  const state: ScanState = st ?? { t, seqN, addrs: null, vals: null, base: null, baseLen: 0 };
  const out: number[] = [];
  const valsOut: number[] = [];
  let overflow = false;

  /* Сравнение ОДНОЙ позиции цепочки. sv — «своё» значение для операторов (не задано —
     главный v: одиночный поиск работает ровно как раньше); ref — прошлое значение. */
  const posOk = (cur: number, ref: number, p: number): boolean => {
    const sv = seq.length > p ? seq[p] : v;
    switch (kind) {
      case 'exact': return sameVal(cur, sv, float);
      case 'ne': return !sameVal(cur, sv, float);
      case 'gt': return cur > sv;
      case 'lt': return cur < sv;
      case 'ge': return cur > sv || sameVal(cur, sv, float);
      case 'le': return cur < sv || sameVal(cur, sv, float);
      case 'changed': return !sameVal(cur, ref, float);
      case 'unchanged': return sameVal(cur, ref, float);
      case 'inc': return cur > ref;
      case 'dec': return cur < ref;
    }
  };

  if (state.addrs) {
    // Фильтрация прошлого списка — быстрый путь (каждая позиция цепочки — своё сравнение).
    const sn = state.seqN;
    const total = state.addrs.length;
    for (let i = 0; i < total; i++) {
      if ((i & 0xffff) === 0) { onChunk?.(i, total); await yieldToUi(); heap = getHeap(); if (!heap) throw new Error('Эмулятор перезапустился — повторите поиск'); }
      const a = state.addrs[i];
      let all = true;
      for (let p = 0; p < sn; p++) {
        const cur = readAt(heap, a + p * sz, t);
        if (cur === null) { all = false; break; }
        const ref = state.vals ? state.vals[i * sn + p] : v;
        if (!posOk(cur, ref, p)) { all = false; break; }
      }
      if (all) {
        if (out.length < SCAN_CAP) {
          out.push(a);
          for (let p = 0; p < sn; p++) valsOut.push(readAt(heap, a + p * sz, t) ?? 0);
        } else overflow = true;
      }
    }
    onChunk?.(total, total);
    const addrs = Uint32Array.from(out);
    const vals = Float64Array.from(valsOut);
    return {
      result: { addrs, vals, count: out.length, overflow, scanned: total },
      state: { t, seqN: sn, addrs, vals, base: state.base, baseLen: state.baseLen },
    };
  }

  // Полный проход по памяти (первый точный поиск или фильтр после «неизвестного»).
  const total = heap.length;
  const base = state.base;
  const lim = base ? Math.min(base.length, heap.length) : heap.length;
  // цепочка должна лежать ЦЕЛИКОМ: последний байт a+seqN*sz-1 — в пределах lim
  for (let a = 0; a + state.seqN * sz <= lim; a++) {
    if ((a & (CHUNK - 1)) === 0 && a > 0) {
      onChunk?.(a, total);
      await yieldToUi();
      heap = getHeap();
      if (!heap) throw new Error('Эмулятор перезапустился — повторите поиск');
    }
    const cur0 = readAt(heap, a, t);
    if (cur0 === null) continue;
    if (base) {
      const ref0 = readAt(base, a, t);
      if (ref0 === null || !posOk(cur0, ref0, 0)) continue;
    } else if (kind === 'exact' && !sameVal(cur0, seq.length > 0 ? seq[0] : v, float)) continue;
    let all = true;
    for (let p = 1; p < state.seqN; p++) {
      const cur = readAt(heap, a + p * sz, t);
      if (cur === null) { all = false; break; }
      let ref = v;
      if (base) {
        const r = readAt(base, a + p * sz, t);
        if (r === null) { all = false; break; }
        ref = r;
      }
      if (!posOk(cur, ref, p)) { all = false; break; }
    }
    if (!all) continue;
    if (out.length < SCAN_CAP) {
      out.push(a);
      valsOut.push(cur0);
      for (let p = 1; p < state.seqN; p++) valsOut.push(readAt(heap, a + p * sz, t) ?? 0);
    } else overflow = true;
  }
  onChunk?.(total, total);
  // Переполнение в цепочке «неизвестного значения»: список не сохраняем, но обновляем
  // снимок — следующий фильтр продолжит сравнение с ЭТОГО момента (как в ArtMoney).
  if (overflow && base) {
    const newBase = heap.slice(0);
    return {
      result: { addrs: null, vals: null, count: out.length, overflow: true, scanned: total },
      state: { t, seqN: state.seqN, addrs: null, vals: null, base: newBase, baseLen: newBase.length },
    };
  }
  const addrs = Uint32Array.from(out);
  const vals = Float64Array.from(valsOut);
  return {
    result: { addrs, vals, count: out.length, overflow, scanned: total },
    state: { t, seqN: state.seqN, addrs, vals, base: state.base, baseLen: state.baseLen },
  };
}

/* ---------- v0.71 ПЕРЕВОДЧИК ЦИФР ----------
   Не все игры хранят число «как есть». Классика NES: в памяти лежит НЕ количество
   жизней, а НОМЕР ТАЙЛА цифры, которой жизни рисуются на экране. Тайлы цифр 0–9
   в чри Darkwing Duck начинаются с 0x70, поэтому 3 жизни = 0x70+3 = 0x73 = 115 —
   прямой поиск «3» пуст, а «115» находит. У других игр база другая (0x60, 0x50…),
   кто-то пишет ASCII-символ цифры (48+3=51), кто-то счёт от единицы, кто-то BCD.
   Универсального правила нет — поэтому переводчик выдаёт СПИСОК КАНДИДАТОВ,
   каждого можно скормить поиску. Если не сработал ни один кандидат — число
   спрятано хитрее (счётчик тиков, инвертированные биты): тогда «Неизвестное
   значение» (снимок → изменилось/выросло/уменьшилось) находит его при ЛЮБОМ
   кодировании, потому что ищет не значение, а его ИЗМЕНЕНИЯ. */

/** Частые базы тайлов цифр в NES/SNES-чри (0x30 совпадает с ASCII — уже есть). */
export const DIGIT_TILE_BASES = [0x70, 0x60, 0x50, 0xa0, 0xb0];

export type DigitCand = { v: number; why: string };

/** Число на экране → кандидаты, которыми оно может лежать в памяти (без дублей по значению). */
export const digitCandidates = (n: number): DigitCand[] => {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 255) return [];
  const out: DigitCand[] = [];
  const push = (v: number, why: string) => {
    if (v >= 0 && v <= 255 && !out.some((c) => c.v === v)) out.push({ v, why });
  };
  push(n, 'как есть — игра хранит само число');
  push(n + 1, 'со счётом от единицы: на экране «3» — в памяти 4');
  if (n <= 9) {
    push(n + 0x70, `тайл цифры: 0x70+${n} — как в Darkwing Duck (3 жизни = 0x73 = 115)`);
    push(n + 48, `ASCII-символ «${n}» (${(n + 48).toString(16).toUpperCase()})`);
    for (const b of DIGIT_TILE_BASES) if (b !== 0x70) push(n + b, `тайл цифры: 0x${b.toString(16)}+${n} — другая база чри`);
  }
  if (n <= 99) {
    const bcd = Math.floor(n / 10) * 16 + (n % 10);
    push(bcd, `BCD: десятки в старшем полубайте (${n} → 0x${bcd.toString(16).toUpperCase().padStart(2, '0')})`);
  }
  return out;
};

/** Найденный в памяти байт → человекочитательные расшифровки (обратный перевод). */
export const byteDecodes = (v: number): string[] => {
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > 255) return [];
  const out: string[] = [`само число ${v}`];
  if (v >= 1) out.push(`счёт от единицы → на экране ${v - 1}`);
  if (v >= 48 && v <= 57) out.push(`ASCII-цифра «${v - 48}»`);
  for (const b of DIGIT_TILE_BASES) {
    const d = v - b;
    if (d >= 0 && d <= 9) out.push(`тайл цифры ${d} (база 0x${b.toString(16)}${b === 0x70 ? ' — как в Darkwing Duck' : ''})`);
  }
  const bcd = ((v >> 4) & 0xf) * 10 + (v & 0xf);
  if ((v >> 4) <= 9 && (v & 0xf) <= 9 && bcd !== v && bcd > 0) out.push(`BCD → на экране ${bcd}`);
  return out;
};
