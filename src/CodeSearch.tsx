import { useEffect, useRef, useState } from 'react';
import { useApp } from './store';
import { GhostBtn, Ic, PxBtn } from './ui';
import { sfx } from './sound';
import type { SegaApi } from './SegaBox';
import type { CodeOp, CodeType } from './types';
import {
  CODE_TYPE_LABEL, OP_LABEL, SCAN_CAP, formatCond, hex8, parseCond, parseHex, readAt, runScan, writeAt,
  type FilterKind, type ScanState,
} from './memcode';

/* ---------- v0.68 CODESEARCH — окно поиска по памяти эмулятора ----------
   Открывается кнопкой CodeSearch в «Запуске эмулятора» поверх работающей игры.
   Игра продолжает крутиться: ищете значение → меняете его в игре → фильтруете
   список — ровно как в ArtMoney. Найденный адрес можно править (проверка),
   заморозить и превратить в УСЛОВИЕ ЗАДАНИЯ (код RPC1:…), которое вставляется
   в редакторе заданий — задание тогда зачитывается само, по памяти. */

const ROWS = 100;          // сколько адресов-кандидатов показываем (живые значения)
const WALL_ROWS = 24;      // строк по 16 байт в «стене кода»
const FREEZE_MS = 250;     // период подкормки замороженных значений
const VALS_MS = 800;       // период обновления значений в списке
const WALL_MS = 650;       // период обновления стены

type Row = { a: number; v: number };
type WallView = { cur: Uint8Array; prev: Uint8Array | null; off: number };

const OPS: CodeOp[] = ['eq', 'ne', 'gt', 'lt', 'ge', 'le'];

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
  const [pasteIn, setPasteIn] = useState('');
  const [pasteErr, setPasteErr] = useState('');

  const stRef = useRef<ScanState | null>(null);
  const addrsRef = useRef<Uint32Array | null>(null);
  const frozenRef = useRef<Record<number, number>>({});
  frozenRef.current = frozen;
  const prevWallRef = useRef<Uint8Array | null>(null);

  const getHeap = () => getApi()?.getHeap() ?? null;
  const heapReady = !!getHeap();
  const heapLen = getHeap()?.length ?? 0;

  /* ---------- СТЕНА КОДА: снимок окна памяти (живой по таймеру и по навигации) ---------- */
  useEffect(() => {
    if (!wallOpen) return;
    const fetchWall = () => {
      const heap = getHeap();
      if (!heap) return;
      const len = WALL_ROWS * 16;
      const a = Math.max(0, Math.min(wallAddr, Math.max(0, heap.length - len)));
      const cur = heap.slice(a, a + len);
      const prev = prevWallRef.current && prevWallRef.current.length === cur.length ? prevWallRef.current : null;
      setWallView({ cur, prev, off: a });
      prevWallRef.current = cur;
    };
    fetchWall();
    if (!wallLive) return;
    const iv = setInterval(fetchWall, WALL_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallOpen, wallLive, wallAddr]);

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

  /* ---------- ЖИВЫЕ ЗНАЧЕНИЯ в списке результатов ---------- */
  useEffect(() => {
    if (!addrsRef.current || !addrsRef.current.length) return;
    const iv = setInterval(() => {
      const heap = getHeap();
      const addrs = addrsRef.current;
      if (!heap || !addrs) return;
      const n = Math.min(ROWS, addrs.length);
      const out: Row[] = [];
      for (let i = 0; i < n; i++) {
        const v = readAt(heap, addrs[i], t);
        if (v !== null) out.push({ a: addrs[i], v });
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
      const v = readAt(heap, addrs[i], t);
      if (v !== null) out.push({ a: addrs[i], v });
    }
    setRows(out);
  };

  const applyResult = (r: { addrs: Uint32Array | null; count: number; overflow: boolean }) => {
    addrsRef.current = r.addrs;
    setRes({ count: r.count, overflow: r.overflow, unknown: r.addrs === null });
    setRows([]);
    setCondAddr(null);
    setEditAddr(null);
    const heap = getHeap();
    if (r.addrs && heap) {
      const out: Row[] = [];
      for (let i = 0; i < Math.min(ROWS, r.addrs.length); i++) {
        const v = readAt(heap, r.addrs[i], t);
        if (v !== null) out.push({ a: r.addrs[i], v });
      }
      setRows(out);
    }
  };

  const doScan = async (kind: FilterKind, isFirst: boolean) => {
    if (busy) return;
    const heap = getHeap();
    if (!heap) { toast('Ядро ещё не поднялось — дайте игре запуститься', 'err'); return; }
    const vNum = Number(isFirst && kind === 'exact' ? val : fVal);
    if (kind === 'exact' && !Number.isFinite(vNum)) { toast('Введите число для поиска', 'err'); return; }
    setBusy(true);
    setProg({ d: 0, n: 1 });
    try {
      const { result, state } = await runScan(getHeap, isFirst ? null : stRef.current, t, kind, vNum, (d, n) => setProg({ d, n }));
      stRef.current = state;
      applyResult(result);
      if (result.overflow) toast(`Совпадений больше ${SCAN_CAP.toLocaleString('ru-RU')} — сузьте поиск фильтром`, 'err');
      else if (kind === 'exact' && isFirst) toast(`Совпадений: ${result.count.toLocaleString('ru-RU')}`, 'ok');
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

  const writeRow = (a: number, raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) { toast('Введите число', 'err'); return; }
    const heap = getHeap();
    if (!heap) return;
    if (writeAt(heap, a, t, v)) {
      setRows((rs) => rs.map((r) => (r.a === a ? { ...r, v } : r)));
      setFrozen((f) => (a in f ? { ...f, [a]: v } : f));
      toast(`Записано ${v} в 0x${hex8(a)} — если адрес найден верно, игра отреагирует сразу`, 'ok');
    } else toast('Запись не удалась — адрес вне памяти', 'err');
  };

  const toggleFreeze = (a: number) => {
    setFrozen((f) => {
      const next = { ...f };
      if (a in next) delete next[a];
      else {
        const cur = rows.find((r) => r.a === a)?.v;
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
          <GhostBtn onClick={onClose} title="Закрыть (игра продолжит работать)">{Ic.cross(13)}</GhostBtn>
        </div>

        <div className="p-4 space-y-4">
          {/* ---------- ПОИСК ---------- */}
          <div className="border-2 border-edge px-3 py-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-pixel text-[8px] text-gold uppercase shrink-0">шаг 1 · поиск</span>
              <select className="field-in px-2 py-1.5 text-[11px]" value={t} onChange={(e) => { setT(e.target.value as CodeType); resetScan(); }} title="Размер и тип значения в памяти">
                {(Object.keys(CODE_TYPE_LABEL) as CodeType[]).map((k) => <option key={k} value={k}>{CODE_TYPE_LABEL[k]}</option>)}
              </select>
              <input className="field-in w-28 px-2 py-1.5 text-[12px]" placeholder="значение" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doScan('exact', true); }} />
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
                  <input className="field-in w-28 px-2 py-1.5 text-[12px]" placeholder="новое значение" value={fVal} onChange={(e) => setFVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doScan(fKind, false); }} />
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
                              <button className="cursor-pointer hover:text-gold" title="Клик — править значение" onClick={() => { setEditAddr(r.a); setEditVal(String(r.v)); }}>{r.v}</button>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right whitespace-nowrap">
                            <button className={`px-1 cursor-pointer ${editAddr === r.a ? 'text-gold' : 'text-faint hover:text-paper'}`} title="Изменить значение (проверка адреса)" onClick={() => { setEditAddr(r.a); setEditVal(String(r.v)); }}>✏</button>
                            <button className={`px-1 cursor-pointer ${r.a in frozen ? 'text-sky' : 'text-faint hover:text-sky'}`} title={r.a in frozen ? 'Разморозить' : 'Заморозить: вписывать значение обратно, игра его не изменит'} onClick={() => toggleFreeze(r.a)}>❄</button>
                            <button className="px-1 text-faint hover:text-gold cursor-pointer" title="Показать это место в стене кода" onClick={() => { setWallAddr(r.a); setWallIn(hex8(r.a)); setWallOpen(true); prevWallRef.current = null; }}>👁</button>
                            <button className={`px-1 cursor-pointer ${condAddr === r.a ? 'text-gold' : 'text-faint hover:text-gold'}`} title="Сделать условием задания" onClick={() => { setCondAddr(r.a); setCondVal(String(r.v)); setCondOp('eq'); }}>🎯</button>
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
                {condSel !== undefined && <span className="tick-label text-faint">сейчас там: {condSel.v}</span>}
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
                            {bytes.map((b, i) => (
                              <span key={i} className={wallView.prev && wallView.prev[row * 16 + i] !== b ? 'text-coral' : 'text-paper/85'}>
                                {b.toString(16).padStart(2, '0').toUpperCase()}
                                {i < 15 ? ' ' : ''}
                              </span>
                            ))}
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
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
