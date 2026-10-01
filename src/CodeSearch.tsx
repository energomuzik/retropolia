import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from './store';
import { GhostBtn, Ic, PxBtn } from './ui';
import { sfx } from './sound';
import type { SegaApi } from './SegaBox';
import type { CodeOp, CodeType } from './types';
import {
  CODE_TYPE_LABEL, OP_LABEL, SCAN_CAP, formatCond, hex8, parseCond, parseHex, readAt, runScan, typeSize, writeAt,
  byteDecodes, digitCandidates,
  type FilterKind, type ScanState,
} from './memcode';

/* ---------- v0.68/v0.69 CODESEARCH — окно поиска по памяти эмулятора ----------
   Открывается кнопкой CodeSearch в «Запуске эмулятора» поверх работающей игры.
   Игра продолжает крутиться: ищете значение → меняете его в игре → фильтруете
   список — ровно как в ArtMoney. Найденный адрес можно править (проверка),
   заморозить и превратить в УСЛОВИЕ ЗАДАНИЯ (код RPC1:…), которое вставляется
   в редакторе заданий — задание тогда зачитывается само, по памяти.
   v0.69: (1) КНОПКА «СВЕРНУТЬ» — окно сворачивается в маленькую плашку в углу,
   весь поиск (состояние, результаты, заморозка) ЖИВЁТ: играйте в игру спокойно
   и разверните обратно — продолжите с того же места; закрытие при активном
   поиске — двухшаговое (случайный клик крестик не сработает).
   (2) ПОСЛЕДОВАТЕЛЬНОСТИ: 2–4 значения через пробел — ищем места, где они лежат
   в памяти ПОДРЯД (HP и максимум рядом — как в ArtMoney у «пользовательского типа»). */

const ROWS = 100;          // сколько адресов-кандидатов показываем (живые значения)
const WALL_ROWS = 24;      // строк по 16 байт в «стене кода»
const FREEZE_MS = 250;     // период подкормки замороженных значений
const VALS_MS = 800;       // период обновления значений в списке
const WALL_MS = 650;       // период обновления стены

type Row = { a: number; v: number[] };
type WallView = { cur: Uint8Array; prev: Uint8Array | null; off: number };

const OPS: CodeOp[] = ['eq', 'ne', 'gt', 'lt', 'ge', 'le'];
const MAX_SEQ = 4; // максимум значений в последовательности

/** Строка ввода → список значений последовательности: «3 45» → [3, 45] («3,45; 12» тоже можно). */
const parseVals = (s: string): number[] => {
  const parts = s.trim().split(/[\s,;]+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return [];
    out.push(n);
  }
  return out;
};

export default function CodeSearchModal({ getApi, romName, onClose }: {
  getApi: () => SegaApi | null;
  romName: string;
  onClose: () => void;
}) {
  const toast = useApp((s) => s.toast);
  const [t, setT] = useState<CodeType>('u8');
  const [val, setVal] = useState('3');
  const [fKind, setFKind] = useState<FilterKind>('exact');
  const [fVal, setFVal] = useState('2');
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<{ d: number; n: number } | null>(null);
  const [res, setRes] = useState<{ count: number; overflow: boolean; unknown: boolean } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [editAddr, setEditAddr] = useState<number | null>(null);
  const [editVal, setEditVal] = useState('');
  const [frozen, setFrozen] = useState<Record<number, number>>({});
  const [condAddr, setCondAddr] = useState<number | null>(null);
  const [condOp, setCondOp] = useState<CodeOp>('eq');
  const [condVal, setCondVal] = useState('');
  const [wallOpen, setWallOpen] = useState(false);
  const [wallAddr, setWallAddr] = useState(0);
  const [wallIn, setWallIn] = useState('');
  const [wallLive, setWallLive] = useState(true);
  const [wallView, setWallView] = useState<WallView | null>(null);
  /* v0.70 ПРАВКА БАЙТА ПРЯМО В СТЕНЕ: клик по hex-байту → поле ввода → запись в память.
     Рядом с жизнями так же правятся соседние счётчики — ручной поиск изменений. */
  const [wallEdit, setWallEdit] = useState<{ off: number; raw: string } | null>(null);
  const [pasteIn, setPasteIn] = useState('');
  const [pasteErr, setPasteErr] = useState('');
  /* v0.71 ПЕРЕВОДЧИК ЦИФР: «3» на экране может лежать в памяти как 4 (счёт от 1),
     51 (ASCII), 115 (тайл 0x70+3 — Darkwing Duck) и т.д. Переводим число в
     кандидатов и ищем каждого кнопкой — вместо слепого перебора руками. */
  const [trOpen, setTrOpen] = useState(true);
  const [trIn, setTrIn] = useState('3');
  const [trFound, setTrFound] = useState('');
  /* v0.69: сворачивание — окно живёт в свёрнутом виде (состояние поиска сохраняется),
     двухшаговое закрытие при активном поиске (случайный клик не стирает работу) */
  const [min, setMin] = useState(false);
  const [closeArm, setCloseArm] = useState(false);
  const closeArmTRef = useRef<number | null>(null);

  const stRef = useRef<ScanState | null>(null);
  const addrsRef = useRef<Uint32Array | null>(null);
  const frozenRef = useRef<Record<number, number>>({});
  frozenRef.current = frozen;
  const prevWallRef = useRef<Uint8Array | null>(null);

  const getHeap = () => getApi()?.getHeap() ?? null;
  const heapReady = !!getHeap();
  const heapLen = getHeap()?.length ?? 0;

  /* ширина текущей последовательности (1 — обычный поиск) */
  const seqN = stRef.current?.seqN ?? 1;
  const scanActive = !!res || !!stRef.current;
  const tryClose = () => {
    if (scanActive && !closeArm) {
      setCloseArm(true);
      if (closeArmTRef.current !== null) window.clearTimeout(closeArmTRef.current);
      closeArmTRef.current = window.setTimeout(() => setCloseArm(false), 4000);
      sfx.click();
      return;
    }
    onClose();
  };

  /* v0.69: прочитать ЦЕПОЧКУ значений по адресу (seqN штук подряд) */
  const readRowVals = (heap: Uint8Array, a: number, ty: CodeType = t): number[] | null => {
    const n = stRef.current?.seqN ?? 1;
    const out: number[] = [];
    for (let p = 0; p < n; p++) {
      const x = readAt(heap, a + p * typeSize(ty), ty);
      if (x === null) return null;
      out.push(x);
    }
    return out;
  };

  /* ---------- СТЕНА КОДА: снимок окна памяти (живой по таймеру и по навигации) ---------- */
  const refreshWall = useCallback(() => {
    const heap = getHeap();
    if (!heap) return;
    const len = WALL_ROWS * 16;
    const a = Math.max(0, Math.min(wallAddr, Math.max(0, heap.length - len)));
    const cur = heap.slice(a, a + len);
    const prev = prevWallRef.current && prevWallRef.current.length === cur.length ? prevWallRef.current : null;
    setWallView({ cur, prev, off: a });
    prevWallRef.current = cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallAddr]);

  useEffect(() => {
    if (!wallOpen) return;
    refreshWall();
    if (!wallLive) return;
    const iv = setInterval(refreshWall, WALL_MS);
    return () => clearInterval(iv);
  }, [wallOpen, wallLive, refreshWall]);

  /* v0.70: правка байта из стены — ввод в ДЕСЯТИЧНОМ виде (0–255) или 0x-hex (0x00–0xFF);
     после записи снимок перечитывается сразу — записанный байт подсветится красным */
  const writeWallByte = (off: number, raw: string) => {
    const sIn = raw.trim();
    if (!sIn) { setWallEdit(null); return; }
    const v = sIn.toLowerCase().startsWith('0x') ? parseHex(sIn) : Number(sIn);
    if (v === null || !Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > 255) {
      toast('Значение байта — число 0…255 (или 0x00…0xFF)', 'err');
      return;
    }
    const heap = getHeap();
    if (!heap) return;
    if (writeAt(heap, off, 'u8', v)) {
      setWallEdit(null);
      refreshWall();
      toast(`В 0x${hex8(off)} записано ${v} (0x${v.toString(16).toUpperCase().padStart(2, '0')}) — если это жизни, они изменятся сразу`, 'ok');
    } else toast('Запись не удалась — адрес вне памяти', 'err');
  };

  /* ---------- ЗАМОРОЗКА: периодически вписываем запомненное значение обратно ---------- */
  useEffect(() => {
    const keys = Object.keys(frozen);
    if (!keys.length) return;
    const iv = setInterval(() => {
      const heap = getHeap();
      if (!heap) return;
      for (const k of keys) {
        const a = Number(k);
        const v = frozenRef.current[a];
        const cur = readAt(heap, a, t);
        if (cur !== null && cur !== v) writeAt(heap, a, t, v);
      }
    }, FREEZE_MS);
    return () => clearInterval(iv);
  }, [frozen, t]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- ЖИВЫЕ ЗНАЧЕНИЯ в списке результатов (для цепочек — все позиции) ---------- */
  useEffect(() => {
    if (!addrsRef.current || !addrsRef.current.length) return;
    const iv = setInterval(() => {
      const heap = getHeap();
      const addrs = addrsRef.current;
      if (!heap || !addrs) return;
      const n = Math.min(ROWS, addrs.length);
      const out: Row[] = [];
      for (let i = 0; i < n; i++) {
        const vs = readRowVals(heap, addrs[i]);
        if (vs) out.push({ a: addrs[i], v: vs });
      }
      setRows(out);
    }, VALS_MS);
    return () => clearInterval(iv);
  }, [t, res]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshRowsNow = () => {
    const heap = getHeap();
    const addrs = addrsRef.current;
    if (!heap || !addrs) return;
    const out: Row[] = [];
    for (let i = 0; i < Math.min(ROWS, addrs.length); i++) {
      const vs = readRowVals(heap, addrs[i]);
      if (vs) out.push({ a: addrs[i], v: vs });
    }
    setRows(out);
  };

  const applyResult = (r: { addrs: Uint32Array | null; count: number; overflow: boolean }, ty: CodeType = t) => {
    addrsRef.current = r.addrs;
    setRes({ count: r.count, overflow: r.overflow, unknown: r.addrs === null });
    setRows([]);
    setCondAddr(null);
    setEditAddr(null);
    const heap = getHeap();
    if (r.addrs && heap) {
      const out: Row[] = [];
      for (let i = 0; i < Math.min(ROWS, r.addrs.length); i++) {
        const vs = readRowVals(heap, r.addrs[i], ty);
        if (vs) out.push({ a: r.addrs[i], v: vs });
      }
      setRows(out);
    }
  };

  const doScan = async (kind: FilterKind, isFirst: boolean, tOverride?: CodeType) => {
    if (busy) return;
    const heap = getHeap();
    if (!heap) { toast('Ядро ещё не поднялось — дайте игре запуститься', 'err'); return; }
    const ty = tOverride ?? t; // v0.71: переводчик цифр ищет гарантированно «1 байт», не дожидаясь ререндера
    /* v0.69: в строке можно ввести 2–4 значения через пробел — ПОСЛЕДОВАТЕЛЬНОСТЬ.
       Первый поиск задаёт ширину цепочки; фильтры обязаны держать ту же ширину. */
    const seq = parseVals(isFirst ? val : fVal);
    const wantN = isFirst ? Math.min(MAX_SEQ, Math.max(1, seq.length || 1)) : (stRef.current?.seqN ?? 1);
    if (seq.length > MAX_SEQ) { toast(`Максимум ${MAX_SEQ} значения подряд`, 'err'); return; }
    const valueOps = !(['changed', 'unchanged', 'inc', 'dec'] as FilterKind[]).includes(kind);
    if (kind === 'exact' && !seq.length) { toast(isFirst ? 'Введите число (или 2–4 через пробел — последовательность)' : 'Введите число', 'err'); return; }
    if (!isFirst && valueOps && seq.length !== wantN) {
      toast(wantN > 1 ? `Эта последовательность ищет ${wantN} значений подряд — введите ровно ${wantN} числа через пробел` : 'Введите одно число', 'err');
      return;
    }
    setBusy(true);
    setProg({ d: 0, n: 1 });
    try {
      const { result, state } = await runScan(getHeap, isFirst ? null : stRef.current, ty, kind, seq[0] ?? 0, (d, n) => setProg({ d, n }), seq);
      stRef.current = state;
      applyResult(result, ty);
      if (result.overflow) toast(`Совпадений больше ${SCAN_CAP.toLocaleString('ru-RU')} — сузьте поиск фильтром`, 'err');
      else if (kind === 'exact' && isFirst) toast(state.seqN > 1 ? `Мест, где все ${state.seqN} значения лежат подряд: ${result.count.toLocaleString('ru-RU')}` : `Совпадений: ${result.count.toLocaleString('ru-RU')}`, 'ok');
      else if (kind === 'changed' && isFirst) toast('Снимок памяти снят — меняйте значение в игре и фильтруйте', 'ok');
      else toast(`Осталось совпадений: ${result.count.toLocaleString('ru-RU')}`, 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Поиск не удался', 'err');
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  const resetScan = () => {
    stRef.current = null;
    addrsRef.current = null;
    setRes(null);
    setRows([]);
    setFrozen({});
    setCondAddr(null);
    setEditAddr(null);
  };

  /* v0.71: искать кандидата переводчика — обычный первый поиск, но гарантированно «1 байт» (u8) */
  const runTranslated = (v: number) => {
    if (busy) return;
    setT('u8');
    setVal(String(v));
    void doScan('exact', true, 'u8');
  };

  const trCands = digitCandidates(Number(trIn));
  const trNum = Number(trFound);
  const trHints = byteDecodes(trNum);

  const writeRow = (a: number, raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) { toast('Введите число', 'err'); return; }
    const heap = getHeap();
    if (!heap) return;
    if (writeAt(heap, a, t, v)) {
      /* в цепочке правим только ПЕРВОЕ значение (остальные позиции не трогаем) */
      setRows((rs) => rs.map((r) => (r.a === a ? { ...r, v: r.v.map((x, i) => (i === 0 ? v : x)) } : r)));
      setFrozen((f) => (a in f ? { ...f, [a]: v } : f));
      toast(`Записано ${v} в 0x${hex8(a)} — если адрес найден верно, игра отреагирует сразу`, 'ok');
    } else toast('Запись не удалась — адрес вне памяти', 'err');
  };

  const toggleFreeze = (a: number) => {
    setFrozen((f) => {
      const next = { ...f };
      if (a in next) delete next[a];
      else {
        const cur = rows.find((r) => r.a === a)?.v[0]; // ❄ морозит ПЕРВОЕ значение цепочки
        if (cur === undefined) { toast('Сначала перечитайте значения — адрес не в списке', 'err'); return f; }
        next[a] = cur;
      }
      return next;
    });
  };

  const condCode = condAddr !== null ? formatCond({ a: condAddr, t, op: condOp, v: Number(condVal) || 0 }) : '';
  const condValid = condAddr !== null && condVal.trim() !== '' && Number.isFinite(Number(condVal));

  const copyCond = async () => {
    if (!condValid) return;
    try {
      await navigator.clipboard.writeText(condCode);
      toast('Код условия скопирован — вставьте его в «Зачёт по коду» или «Поражение по коду» в редакторе заданий', 'ok');
    } catch {
      toast('Браузер не дал скопировать сам — выделите код ниже и скопируйте вручную', 'err');
    }
  };

  const wallGo = (raw: string) => {
    const n = parseHex(raw);
    if (n === null) { toast('Адрес — шестнадцатеричное число, например 001AB2C8', 'err'); return; }
    prevWallRef.current = null;
    setWallAddr(n);
  };

  const condSel = rows.find((r) => r.a === condAddr);

  /* ---------- v0.69: СВЁРНУТЫЙ ВИД — маленькая плашка в углу, поиск живёт ---------- */
  if (min) {
    return (
      <div className="fixed left-2 bottom-2 sm:left-3 sm:bottom-3 z-40 pixel-panel pixel-corners border-2 border-edge bg-[#0b0e1c] px-2.5 py-1.5 flex items-center gap-2 max-w-[calc(100vw-1rem)]">
        <span className="text-teal shrink-0">{Ic.chip(14)}</span>
        <button
          className="font-display text-[11px] uppercase tracking-wider text-teal cursor-pointer hover:text-gold whitespace-nowrap"
          onClick={() => { setMin(false); sfx.click(); }}
          title="Развернуть CodeSearch — поиск, результаты и заморозка сохранены"
        >
          CodeSearch{busy ? ' · поиск…' : res ? ` · ${res.count.toLocaleString('ru-RU')}${res.overflow ? '+' : ''}` : ''}
        </button>
        {Object.keys(frozen).length > 0 && <span className="text-sky text-[11px] shrink-0" title={`Заморожено адресов: ${Object.keys(frozen).length} — значения вписываются обратно даже в свёрнутом виде`}>❄{Object.keys(frozen).length}</span>}
        <GhostBtn small onClick={tryClose} title={closeArm ? 'Поиск ПРОПАДЁТ — нажать ещё раз, чтобы закрыть' : 'Закрыть (поиск будет сброшен)'}>
          {closeArm ? <span className="text-coral font-bold">✕!</span> : Ic.cross(11)}
        </GhostBtn>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-[rgba(3,4,10,0.82)] flex items-start justify-center p-3 sm:p-6 overflow-y-auto">
      <div className="w-full max-w-4xl pixel-panel pixel-corners border-[3px] border-edge bg-[#0b0e1c] my-auto">
        {/* шапка */}
        <div className="flex items-center gap-3 px-4 py-3 border-b-[3px] border-edge">
          <span className="text-teal">{Ic.chip(18)}</span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-sm uppercase tracking-wider text-teal">CodeSearch — память эмулятора</h2>
            <div className="tick-label text-faint truncate">
              {romName} · {heapReady ? `память ядра ${(heapLen / 1024 / 1024).toFixed(1)} МБ — игра работает, играйте и меняйте значения` : 'ядро ещё не готово — запустите ром и подождите пару секунд'}
            </div>
          </div>
          <GhostBtn onClick={() => { setMin(true); sfx.click(); }} title="Свернуть в плашку в углу — поиграйте в игру и вернитесь: поиск, результаты и заморозка сохранятся">▾</GhostBtn>
          <GhostBtn onClick={tryClose} title={closeArm ? 'Поиск ПРОПАДЁТ — нажать ещё раз, чтобы закрыть' : 'Закрыть (игра продолжит работать)'}>{closeArm ? <span className="text-coral font-bold">✕!</span> : Ic.cross(13)}</GhostBtn>
        </div>

        <div className="p-4 space-y-4">
          {/* ---------- ПОИСК ---------- */}
          <div className="border-2 border-edge px-3 py-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-pixel text-[8px] text-gold uppercase shrink-0">шаг 1 · поиск</span>
              <select className="field-in px-2 py-1.5 text-[11px]" value={t} onChange={(e) => { setT(e.target.value as CodeType); resetScan(); }} title="Размер и тип значения в памяти">
                {(Object.keys(CODE_TYPE_LABEL) as CodeType[]).map((k) => <option key={k} value={k}>{CODE_TYPE_LABEL[k]}</option>)}
              </select>
              <input className="field-in w-44 px-2 py-1.5 text-[12px]" placeholder="значение или 2–4 через пробел" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doScan('exact', true); }} />
              <PxBtn color="teal" small disabled={busy || !heapReady} onClick={() => void doScan('exact', true)} title="Найти ВСЕ адреса памяти, где лежит это значение">
                {stRef.current ? '↻ Поиск заново' : 'Первый поиск'}
              </PxBtn>
              <GhostBtn small onClick={() => void doScan('changed', true)} disabled={busy || !heapReady} title="Снять снимок памяти и искать дальше по ИЗМЕНЕНИЯМ — когда число не видно на экране (полоска босса, флаг оружия)">
                Неизвестное значение
              </GhostBtn>
            </div>
            {stRef.current && (
              <div className="flex items-center gap-2 flex-wrap pt-1.5 border-t border-edge/60">
                <span className="font-pixel text-[8px] text-gold uppercase shrink-0">шаг 2 · среди найденных</span>
                <select className="field-in px-2 py-1.5 text-[11px]" value={fKind} onChange={(e) => setFKind(e.target.value as FilterKind)}>
                  <option value="exact">= значению</option>
                  <option value="ne">≠ значению</option>
                  <option value="gt">&gt; значения</option>
                  <option value="lt">&lt; значения</option>
                  <option value="ge">≥ значения</option>
                  <option value="le">≤ значения</option>
                  <option value="changed">изменилось</option>
                  <option value="unchanged">не изменилось</option>
                  <option value="inc">выросло</option>
                  <option value="dec">уменьшилось</option>
                </select>
                {!(['changed', 'unchanged', 'inc', 'dec'] as FilterKind[]).includes(fKind) ? (
                  <input className="field-in w-44 px-2 py-1.5 text-[12px]" placeholder={seqN > 1 ? `${seqN} значения через пробел` : 'новое значение'} value={fVal} onChange={(e) => setFVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doScan(fKind, false); }} />
                ) : (
                  <span className="tick-label text-faint">значение не нужно — меняйте его в игре и жмите кнопку</span>
                )}
                <PxBtn color="gold" small disabled={busy || !heapReady} onClick={() => void doScan(fKind, false)}>Искать среди найденных</PxBtn>
                <GhostBtn small onClick={resetScan} title="Забыть результаты и начать с нуля">Сброс</GhostBtn>
              </div>
            )}
            {busy && prog && (
              <div className="pt-1">
                <div className="h-2 bg-[#05070f] border border-edge overflow-hidden">
                  <div className="h-full bg-teal transition-all" style={{ width: `${Math.round((prog.d / Math.max(1, prog.n)) * 100)}%` }} />
                </div>
                <div className="tick-label text-faint mt-0.5">сканирование памяти… {(prog.d / 1024 / 1024).toFixed(0)} / {(prog.n / 1024 / 1024).toFixed(0)} МБ</div>
              </div>
            )}
            <p className="text-[10.5px] text-dim leading-tight">
              Как в ArtMoney: ищете «5» (жизней пять) → в игре теряете жизнь → ищете «4» среди найденных → повторяете, пока не останутся 1–3 адреса.
              «Неизвестное значение» — когда число не видно: снимок памяти, потом «изменилось / выросло / уменьшилось» после каждого изменения в игре.
              <b className="text-paper"> Последовательность:</b> введите 2–4 числа через пробел — найдутся места, где они лежат в памяти ПОДРЯД
              (например, текущее HP и максимум рядом — так ищут HP юнитов во Front Mission 3); фильтр тоже принимает столько же чисел;
              в результатах видна вся цепочка, ✏/❄/🎯 работают с первым значением.
              <b className="text-paper"> Число не находится совсем?</b> Переведите его в «переводчике цифр» ниже — некоторые игры хранят
              номер тайла цифры (3 жизни в Darkwing Duck = 115) — или ищите через «Неизвестное значение».
              {' '}Чтобы поменять значение в игре — <b className="text-teal">сверните окно кнопкой ▾</b> и разверните обратно: поиск сохранится.
            </p>
          </div>

          {/* ---------- РЕЗУЛЬТАТЫ ---------- */}
          {res && (
            <div className="border-2 border-edge px-3 py-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-pixel text-[8px] text-gold uppercase">совпадений</span>
                <span className="font-display text-[13px] text-paper">{res.count.toLocaleString('ru-RU')}{res.overflow ? '+' : ''}</span>
                {res.unknown && <span className="tick-label text-sky">снимок снят — меняйте значение в игре и фильтруйте «изменилось»</span>}
                {res.overflow && <span className="tick-label text-coral">слишком много — сузьте поиск фильтром</span>}
                {!res.unknown && rows.length > 0 && <GhostBtn small onClick={refreshRowsNow} title="Перечитать значения найденных адресов">↻ Значения</GhostBtn>}
              </div>
              {rows.length > 0 && (
                <div className="max-h-[240px] overflow-y-auto border border-edge">
                  <table className="w-full text-[11px] font-mono">
                    <thead className="sticky top-0 bg-[#0b0e1c]">
                      <tr className="text-faint text-left">
                        <th className="px-2 py-1 font-normal">адрес</th>
                        <th className="px-2 py-1 font-normal">значение</th>
                        <th className="px-2 py-1 font-normal text-right">✏ править · ❄ морозить · 👁 стена · 🎯 условие</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.a} className={`border-t border-edge/50 ${condAddr === r.a ? 'bg-gold/10' : ''}`}>
                          <td className="px-2 py-1 text-sky">0x{hex8(r.a)}</td>
                          <td className="px-2 py-1 text-paper">
                            {editAddr === r.a ? (
                              <input autoFocus className="field-in w-24 px-1.5 py-0.5 text-[11px]" value={editVal} onChange={(e) => setEditVal(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { writeRow(r.a, editVal); setEditAddr(null); } if (e.key === 'Escape') setEditAddr(null); }} />
                            ) : (
                              <button className="cursor-pointer hover:text-gold" title={r.v.length > 1 ? `Цепочка из ${r.v.length} значений подряд — клик: править первое` : 'Клик — править значение'} onClick={() => { setEditAddr(r.a); setEditVal(String(r.v[0])); }}>{r.v.join(' · ')}</button>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right whitespace-nowrap">
                            <button className={`px-1 cursor-pointer ${editAddr === r.a ? 'text-gold' : 'text-faint hover:text-paper'}`} title={r.v.length > 1 ? 'Изменить ПЕРВОЕ значение цепочки (проверка адреса)' : 'Изменить значение (проверка адреса)'} onClick={() => { setEditAddr(r.a); setEditVal(String(r.v[0])); }}>✏</button>
                            <button className={`px-1 cursor-pointer ${r.a in frozen ? 'text-sky' : 'text-faint hover:text-sky'}`} title={r.a in frozen ? 'Разморозить' : 'Заморозить: вписывать значение обратно, игра его не изменит'} onClick={() => toggleFreeze(r.a)}>❄</button>
                            <button className="px-1 text-faint hover:text-gold cursor-pointer" title="Показать это место в стене кода" onClick={() => { setWallAddr(r.a); setWallIn(hex8(r.a)); setWallOpen(true); prevWallRef.current = null; }}>👁</button>
                            <button className={`px-1 cursor-pointer ${condAddr === r.a ? 'text-gold' : 'text-faint hover:text-gold'}`} title={r.v.length > 1 ? 'Сделать условием задания (по ПЕРВОМУ значению цепочки)' : 'Сделать условием задания'} onClick={() => { setCondAddr(r.a); setCondVal(String(r.v[0])); setCondOp('eq'); }}>🎯</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {res.count > ROWS && <div className="px-2 py-1 tick-label text-faint">показаны первые {ROWS} — фильтруйте, чтобы сократить список</div>}
                </div>
              )}
              {Object.keys(frozen).length > 0 && <div className="tick-label text-sky">❄ заморожено адресов: {Object.keys(frozen).length} — значения вписываются обратно автоматически</div>}
            </div>
          )}

          {/* ---------- УСЛОВИЕ ЗАДАНИЯ ---------- */}
          {condAddr !== null && (
            <div className="border-2 border-gold/50 bg-gold/5 px-3 py-3 space-y-2">
              <div className="font-pixel text-[8px] text-gold uppercase">шаг 3 · условие задания (одно условие — одно задание)</div>
              <div className="flex items-center gap-2 flex-wrap text-[12px]">
                <span className="font-mono text-sky">0x{hex8(condAddr)}</span>
                <span className="tick-label text-faint">{CODE_TYPE_LABEL[t]}</span>
                {condSel !== undefined && <span className="tick-label text-faint">сейчас там: {condSel.v.join(' · ')}</span>}
                <select className="field-in px-2 py-1.5 text-[11px]" value={condOp} onChange={(e) => setCondOp(e.target.value as CodeOp)}>
                  {OPS.map((k) => <option key={k} value={k}>{OP_LABEL[k]}</option>)}
                </select>
                <input className="field-in w-28 px-2 py-1.5 text-[12px]" value={condVal} onChange={(e) => setCondVal(e.target.value)} placeholder="значение" />
              </div>
              <p className="text-[10.5px] text-dim leading-tight">
                Код вставляется в редакторе заданий в поле «Зачёт по коду» — тогда задание зачтётся само,
                когда значение по адресу станет {OP_LABEL[condOp]} {condVal || '…'}; а в поле «Поражение по коду» —
                наоборот, задание ПРОВАЛИТСЯ, когда условие выполнится (например, жизни равны 0).
                Условие привязано к ЭТОМУ файлу рома и встроенному ядру эмулятора — другой дамп той же игры может не совпасть.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <PxBtn color="gold" small disabled={!condValid} onClick={() => void copyCond()}>⧉ Скопировать код условия</PxBtn>
                <input readOnly className="field-in flex-1 min-w-[240px] px-2 py-1.5 text-[11px] font-mono text-gold" value={condCode} onFocus={(e) => e.target.select()} />
              </div>
            </div>
          )}

          {/* ---------- ПРОВЕРКА ГОТОВОГО КОДА ---------- */}
          <div className="border-2 border-edge px-3 py-3 space-y-1.5">
            <div className="font-pixel text-[8px] text-gold uppercase">проверить код условия</div>
            <div className="flex items-center gap-2 flex-wrap">
              <input className="field-in flex-1 min-w-[240px] px-2 py-1.5 text-[11px] font-mono" placeholder="RPC1:001AB2C8:u8:eq:3" value={pasteIn} onChange={(e) => { setPasteIn(e.target.value); setPasteErr(''); }} />
              <GhostBtn small onClick={() => {
                const c = parseCond(pasteIn);
                if (!c) { setPasteErr('Не похоже на код условия — формат: RPC1:АДРЕС:ТИП:ОПЕРАТОР:ЗНАЧЕНИЕ'); return; }
                setPasteErr('');
                toast(`Код верный: ${CODE_TYPE_LABEL[c.t]}, 0x${hex8(c.a)} ${OP_LABEL[c.op]} ${c.v}`, 'ok');
              }}>Проверить</GhostBtn>
            </div>
            {pasteErr && <p className="text-[10.5px] text-coral">{pasteErr}</p>}
          </div>

          {/* ---------- v0.71 ПЕРЕВОДЧИК ЦИФР ---------- */}
          <div className="border-2 border-edge px-3 py-3 space-y-2">
            <button className="flex items-center gap-1.5 cursor-pointer" onClick={() => { setTrOpen((v) => !v); sfx.click(); }}>
              <span className={`text-[10px] ${trOpen ? 'text-gold' : 'text-faint'}`}>{trOpen ? '▾' : '▸'}</span>
              <span className="font-pixel text-[8px] text-gold uppercase">переводчик цифр — когда число прямым поиском не находится</span>
            </button>
            {trOpen && (
              <>
                <p className="text-[10.5px] text-dim leading-tight">
                  Игра не всегда хранит число «как есть»: Darkwing Duck держит в памяти НОМЕР ТАЙЛА цифры на экране —
                  тайлы цифр 0–9 в NES-чри начинаются с 0x70, поэтому 3 жизни = 0x70+3 = 0x73 = <b className="text-paper">115</b>:
                  поиск «3» пуст, а «115» находит. Введите число с экрана — переводчик предложит кандидатов, ищите каждого
                  кнопкой (тип «1 байт», поиск заново). Не нашёлся ни один кандидат — число спрятано хитрее: берите
                  «Неизвестное значение» (снимок → меняйте в игре → «изменилось/уменьшилось») — оно находит величину при ЛЮБОМ кодировании.
                </p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="tick-label text-faint shrink-0">на экране число</span>
                  <input className="field-in w-20 px-2 py-1.5 text-[12px]" value={trIn} placeholder="3" onChange={(e) => setTrIn(e.target.value)} />
                  <span className="tick-label text-faint">в памяти может лежать так:</span>
                </div>
                {trCands.length > 0 ? (
                  <div className="space-y-1">
                    {trCands.map((c) => (
                      <div key={c.v} className="flex items-center gap-2 flex-wrap">
                        <PxBtn color="teal" small disabled={busy || !heapReady} onClick={() => runTranslated(c.v)}
                          title={`Первый поиск заново: тип «1 байт» (u8), значение ${c.v} (0x${c.v.toString(16).toUpperCase().padStart(2, '0')})`}>
                          искать {c.v}
                        </PxBtn>
                        <span className="text-[10.5px] text-dim">{c.why}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10.5px] text-coral">Введите целое число 0…255 — переводчик предложит варианты</p>
                )}
                <div className="flex items-center gap-2 flex-wrap pt-1.5 border-t border-edge/60">
                  <span className="tick-label text-faint shrink-0">наоборот: нашлось значение</span>
                  <input className="field-in w-20 px-2 py-1.5 text-[12px]" value={trFound} placeholder="115" onChange={(e) => setTrFound(e.target.value)} />
                  <span className="text-[10.5px] text-teal">
                    {trFound.trim() === ''
                      ? 'впишите байт из стены или результатов — скажу, на что он похож'
                      : !Number.isInteger(trNum) || trNum < 0 || trNum > 255
                        ? 'введите целое число 0…255'
                        : trHints.length
                          ? trHints.join(' · ')
                          : 'похоже на произвольный байт без известного кодирования — проверяйте изменением в игре'}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* ---------- СТЕНА КОДА ---------- */}
          <div className="border-2 border-edge px-3 py-3 space-y-2">
            <button className="flex items-center gap-1.5 cursor-pointer" onClick={() => { setWallOpen((v) => !v); sfx.click(); }}>
              <span className={`text-[10px] ${wallOpen ? 'text-gold' : 'text-faint'}`}>{wallOpen ? '▾' : '▸'}</span>
              <span className="font-pixel text-[8px] text-gold uppercase">стена кода — живой дамп памяти</span>
            </button>
            {wallOpen && (
              <>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="tick-label text-faint">адрес</span>
                  <input className="field-in w-28 px-2 py-1 text-[11px] font-mono" placeholder="001AB2C8" value={wallIn}
                    onChange={(e) => setWallIn(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') wallGo(wallIn); }} />
                  <GhostBtn small onClick={() => wallGo(wallIn)}>Перейти</GhostBtn>
                  <GhostBtn small onClick={() => { prevWallRef.current = null; setWallAddr(Math.max(0, wallAddr - 0x1000)); }} title="−4 КБ">▲▲</GhostBtn>
                  <GhostBtn small onClick={() => { prevWallRef.current = null; setWallAddr(Math.max(0, wallAddr - 16)); }} title="−строка">▲</GhostBtn>
                  <GhostBtn small onClick={() => { prevWallRef.current = null; setWallAddr(wallAddr + 16); }} title="+строка">▼</GhostBtn>
                  <GhostBtn small onClick={() => { prevWallRef.current = null; setWallAddr(wallAddr + 0x1000); }} title="+4 КБ">▼▼</GhostBtn>
                  <label className="flex items-center gap-1 tick-label text-faint cursor-pointer">
                    <input type="checkbox" checked={wallLive} onChange={(e) => setWallLive(e.target.checked)} /> живой
                  </label>
                </div>
                <div className="overflow-x-auto border border-edge bg-[#05070f] p-2">
                  {wallView ? (
                    <div className="font-mono text-[10px] leading-[1.5]">
                      {Array.from({ length: Math.min(WALL_ROWS, Math.ceil(wallView.cur.length / 16)) }).map((_, row) => {
                        const off = wallView.off + row * 16;
                        const bytes = Array.from(wallView.cur.subarray(row * 16, row * 16 + 16));
                        return (
                          <div key={row} className="whitespace-pre">
                            <span className="text-sky">{hex8(off)}</span>
                            {'  '}
                            {bytes.map((b, i) => {
                              const boff = wallView.off + row * 16 + i;
                              if (wallEdit?.off === boff) {
                                return (
                                  <input
                                    key={i}
                                    autoFocus
                                    className="field-in inline-block w-[38px] px-0.5 py-0 text-[10px] font-mono text-center align-baseline"
                                    value={wallEdit.raw}
                                    placeholder={String(b)}
                                    title={`0x${hex8(boff)} — число 0–255 или 0x00–0xFF (Enter — записать, Esc — отмена)`}
                                    onChange={(e) => setWallEdit({ off: boff, raw: e.target.value })}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') writeWallByte(boff, wallEdit.raw);
                                      else if (e.key === 'Escape') setWallEdit(null);
                                    }}
                                    onBlur={() => setWallEdit(null)}
                                  />
                                );
                              }
                              return (
                                <button
                                  key={i}
                                  onClick={() => setWallEdit({ off: boff, raw: String(b) })}
                                  title={`0x${hex8(boff)} · DEC ${b} · 0x${b.toString(16).padStart(2, '0').toUpperCase()} — клик, чтобы вписать своё значение`}
                                  className={`cursor-pointer hover:text-gold ${wallView.prev && wallView.prev[row * 16 + i] !== b ? 'text-coral' : 'text-paper/85'}`}
                                >
                                  {b.toString(16).padStart(2, '0').toUpperCase()}
                                  {i < 15 ? ' ' : ''}
                                </button>
                              );
                            })}
                            {'  '}
                            <span className="text-faint">{bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('')}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="tick-label text-faint py-4 text-center">ждём память ядра…</div>
                  )}
                </div>
                <p className="text-[10.5px] text-dim leading-tight">
                  Каждый байт памяти: адрес строки, 16 байт в hex и те же байты как символы. Красным подсвечиваются байты, изменившиеся с прошлого обновления —
                  рядом с адресом жизней обычно лежат соседние счётчики игры. Стена живёт вместе с игрой (галка «живой»).
                  <b className="text-teal"> Клик по байту — правка на месте:</b> введите число 0…255 (или 0x00…0xFF) и нажмите Enter — значение запишется в память игры сразу.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
