import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { Field, GhostBtn, Ic, Panel, PxBtn, Stepper } from '../ui';
import { CELL, drawBoard, fitView } from '../render';
import { idbPut, uid } from '../db';
import { cartridgeArt, cardArt, fileToDataUrl } from '../assets';
import type { CardDef, CardEffect, EffectType, GameMap, TaskDef } from '../types';
import { sfx } from '../sound';

const EFFECTS: { key: EffectType; label: string; hasValue?: boolean; hasTarget?: boolean; unit?: string; def: number }[] = [
  { key: 'move', label: 'Сдвиг по маршруту на N ячеек', hasValue: true, unit: 'яч. (− назад)', def: 3 },
  { key: 'teleport', label: 'Переход на ячейку под номером N', hasValue: true, unit: '№ ячейки', def: 1 },
  { key: 'jail', label: 'Отпуск: пропуск N ходов', hasValue: true, unit: 'ходов', def: 1 },
  { key: 'wrongway', label: 'Поворот не туда: прыжок к спец-ячейке', def: 0 },
  { key: 'extraTurn', label: 'Дополнительный ход текущего игрока', def: 0 },
  { key: 'skipTurn', label: 'Пропуск хода текущего игрока', def: 0 },
  { key: 'playerExtra', label: 'Доп. ход игроку под номером N', hasTarget: true, def: 0 },
  { key: 'playerSkip', label: 'Пропуск хода игроку под номером N', hasTarget: true, def: 0 },
  { key: 'addMin', label: 'Плюс N минут времени', hasValue: true, unit: 'мин', def: 5 },
  { key: 'subMin', label: 'Минус N минут времени', hasValue: true, unit: 'мин', def: 5 },
  { key: 'addTries', label: 'Плюс N попыток', hasValue: true, unit: 'поп.', def: 5 },
  { key: 'subTries', label: 'Минус N попыток', hasValue: true, unit: 'поп.', def: 5 },
];

export const effectLabel = (e: CardEffect): string => {
  const meta = EFFECTS.find((x) => x.key === e.type);
  if (!meta) return e.type;
  let s = meta.label.replace('N', String(e.value));
  if (meta.hasTarget) s += ` (игрок №${e.target})`;
  return s;
};

export default function TaskEditor() {
  const { maps, roms, saves, setScreen, refresh, toast } = useApp();
  const [map, setMap] = useState<GameMap | null>(null);
  const [selCell, setSelCell] = useState<number | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const mapRef = useRef(map); mapRef.current = map;
  const selRef = useRef(selCell); selRef.current = selCell;

  // форма задания
  const [fRom, setFRom] = useState('');
  const [fSave, setFSave] = useState('');
  const [fTitle, setFTitle] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [fImg, setFImg] = useState('');
  // форма карточки
  const [cName, setCName] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cType, setCType] = useState<EffectType>('move');
  const [cValue, setCValue] = useState(3);
  const [cTarget, setCTarget] = useState(1);
  const [cImg, setCImg] = useState('');
  // оформление ячейки (цвет / название / картинка)
  const [vLabel, setVLabel] = useState('');
  const [vColor, setVColor] = useState('');
  const [vImg, setVImg] = useState('');

  const tiles = useApp((st) => st.tiles);
  const tileById = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);

  const openMap = (m: GameMap) => {
    setMap(JSON.parse(JSON.stringify(m)) as GameMap);
    setSelCell(null);
    requestAnimationFrame(() => {
      const cv = canvasRef.current;
      if (cv) setView(fitView(m, cv.clientWidth, cv.clientHeight));
    });
    sfx.coin();
  };

  useEffect(() => {
    const cell = map && selCell !== null ? map.cells[selCell] : null;
    if (!cell) return;
    setFRom(cell.task?.romId ?? '');
    setFSave(cell.task?.saveId ?? '');
    setFTitle(cell.task?.title ?? '');
    setFDesc(cell.task?.desc ?? '');
    setFImg(cell.task?.imageId ?? '');
    setVLabel(cell.label ?? '');
    setVColor(cell.color ?? '');
    setVImg(cell.imageId ?? '');
  }, [selCell, map?.id]);

  const CELL_COLORS = ['#ffcf3f', '#ff5d73', '#5aa9ff', '#2ee6a8', '#ff8b3f', '#9be84d', '#c07aff', '#e9ecff'];

  const saveVisuals = async () => {
    if (!map || selCell === null) return;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.cells[selCell].label = vLabel.trim() || undefined;
    nextMap.cells[selCell].color = vColor || undefined;
    nextMap.cells[selCell].imageId = vImg || undefined;
    setMap(nextMap);
    await persist(nextMap);
    sfx.coin();
    toast(`Оформление ячейки №${selCell + 1} сохранено`, 'ok');
  };

  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      const cv = canvasRef.current;
      const m = mapRef.current;
      if (cv && m) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.floor(w * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawBoard(ctx, m, {
          view: viewRef.current, width: w, height: h, tileById,
          captured: {}, colorById: {}, currentCell: selRef.current,
          showNumbers: true, tokens: [], time: t, hoverCell: null,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tileById]);

  const persist = async (m: GameMap) => {
    m.updatedAt = Date.now();
    await idbPut('maps', m.id, m);
    await refresh();
  };

  const mutate = (fn: (m: GameMap) => void, silent = true) => {
    setMap((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as GameMap;
      fn(next);
      return next;
    });
    if (!silent) sfx.click();
  };

  const pickCell = (e: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    const v = viewRef.current;
    const wx = v.x + (e.clientX - r.left - r.width / 2) / v.zoom;
    const wy = v.y + (e.clientY - r.top - r.height / 2) / v.zoom;
    const cx = Math.floor(wx / CELL), cy = Math.floor(wy / CELL);
    const m = mapRef.current;
    if (!m) return;
    const idx = m.cells.findIndex((c) => c.x === cx && c.y === cy);
    setSelCell(idx >= 0 ? idx : null);
    if (idx >= 0) sfx.hover();
  };

  const romSaves = saves.filter((s) => s.romId === fRom);
  const cell = map && selCell !== null ? map.cells[selCell] : null;
  const romName = (id: string) => roms.find((r) => r.id === id)?.name ?? '—';

  const saveTask = async () => {
    if (!map || selCell === null) return;
    const romIsNes = roms.find((r) => r.id === fRom)?.ext === 'nes';
    if (!fRom || (romIsNes && !fSave)) {
      sfx.fail();
      toast(romIsNes ? 'Выберите ром и сохранение' : 'Выберите ром', 'err');
      return;
    }
    let imageId: string | undefined = fImg || undefined;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    const task: TaskDef = {
      romId: fRom, saveId: fSave || undefined,
      title: fTitle.trim() || romName(fRom),
      desc: fDesc.trim() || 'Пройдите фрагмент игры, как договорились игроки.',
      imageId,
    };
    nextMap.cells[selCell].task = task;
    setMap(nextMap);
    await persist(nextMap);
    sfx.success();
    toast(`Задание ячейки №${selCell + 1} сохранено`, 'ok');
  };

  const addCard = async () => {
    if (!map || selCell === null) return;
    const kind = map.cells[selCell].type === 'trap' ? 'trap' : 'bonus';
    if (!cName.trim()) { sfx.fail(); toast('Назовите карточку', 'err'); return; }
    let imageId: string | undefined = cImg || undefined;
    const card: CardDef = {
      id: uid('card'), kind, name: cName.trim(),
      desc: cDesc.trim() || effectLabel({ type: cType, value: cValue, target: cTarget }),
      imageId, effect: { type: cType, value: cValue, target: cTarget },
    };
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    (kind === 'bonus' ? nextMap.bonusCards : nextMap.trapCards).push(card);
    setMap(nextMap);
    await persist(nextMap);
    setCName(''); setCDesc(''); setCImg('');
    sfx.card();
    toast(`Карточка «${card.name}» добавлена в колоду`, 'ok');
  };

  const delCard = async (id: string) => {
    if (!map) return;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.bonusCards = nextMap.bonusCards.filter((c) => c.id !== id);
    nextMap.trapCards = nextMap.trapCards.filter((c) => c.id !== id);
    setMap(nextMap);
    await persist(nextMap);
    toast('Карточка удалена', 'err');
  };

  const setCellType = async (type: 'task' | 'bonus' | 'trap' | 'quiz') => {
    if (!map || selCell === null) return;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.cells[selCell].type = type;
    setMap(nextMap);
    await persist(nextMap);
  };

  const delCell = async () => {
    if (!map || selCell === null) return;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.cells.splice(selCell, 1);
    nextMap.cells = nextMap.cells.map((c, i) => ({ ...c, n: i + 1 }));
    setMap(nextMap);
    setSelCell(null);
    await persist(nextMap);
    toast('Ячейка удалена, маршрут перенумерован', 'err');
  };

  const onImg = (setter: (v: string) => void) => async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !f.type.startsWith('image/')) return;
    setter(await fileToDataUrl(f));
    sfx.coin();
  };

  const issues: string[] = [];
  const warns: string[] = [];
  if (map) {
    const bonusCells = map.cells.filter((c) => c.type === 'bonus').length;
    const trapCells = map.cells.filter((c) => c.type === 'trap').length;
    const quizCells = map.cells.filter((c) => c.type === 'quiz').length;
    const noTask = map.cells.filter((c) => c.type === 'task' && !c.task).length;
    if (map.cells.length < 10) issues.push(`Минимум 10 ячеек (сейчас ${map.cells.length})`);
    if (bonusCells > 0 && map.bonusCards.length === 0) issues.push('Есть ячейки-бонусы, но колода бонусов пуста — создайте карточку или уберите ячейки');
    if (trapCells > 0 && map.trapCards.length === 0) issues.push('Есть ячейки-ловушки, но колода ловушек пуста — создайте карточку или уберите ячейки');
    if (quizCells > 0 && (map.quizzes ?? []).length === 0) issues.push('Есть ячейки-квизы, но на карте нет вопросов — создайте квизы в редакторе или уберите ячейки');
    if (noTask > 0) warns.push(`${noTask} ячеек без заданий будут «передышкой» в игре`);
  }

  const completeMap = async () => {
    if (!map) return;
    if (issues.length) { sfx.fail(); toast(issues[0], 'err'); return; }
    const nextMap = { ...map, ready: true };
    setMap(nextMap);
    await persist(nextMap);
    sfx.success();
    toast(`Карта «${map.name}» готова к игре!`, 'ok');
    setScreen('menu');
  };

  if (!map) {
    return (
      <div className="h-full crt-grid-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="flex items-center gap-4 mb-6">
            <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
            <h1 className="font-display text-2xl uppercase tracking-wider text-magma flex items-center gap-3">
              <span className="text-magma">{Ic.cart(22)}</span> Редактор заданий
            </h1>
          </div>
          <p className="text-[13px] text-dim mb-5 max-w-2xl">
            Выберите карту: затем кликайте по ячейкам, привязывайте ром + сохранение, картинку и описание задания.
            Для ячеек-бонусов и ловушек собираются колоды карточек с эффектами.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {maps.map((m) => {
              const noTask = m.cells.filter((c) => c.type === 'task' && !c.task).length;
              return (
                <button key={m.id} onClick={() => openMap(m)} className="text-left pixel-panel pixel-corners p-4 transition-transform hover:-translate-y-1 hover:border-edge2 cursor-pointer group">
                  <div className="flex items-center justify-between">
                    <span className="font-display uppercase text-paper group-hover:text-gold transition-colors">{m.name}</span>
                    {m.ready ? <span className="tick-label text-teal">Готова</span> : <span className="tick-label text-gold">В работе</span>}
                  </div>
                  <div className="tick-label text-faint mt-2">
                    {m.cells.length} ячеек · бонус-колода {m.bonusCards.length} · ловушки {m.trapCards.length}
                  </div>
                  <div className="tick-label mt-1" style={{ color: noTask ? '#ff8b3f' : '#2ee6a8' }}>
                    {noTask ? `Без заданий: ${noTask}` : 'Все задания заполнены'}
                  </div>
                </button>
              );
            })}
            {maps.length === 0 && (
              <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-sm col-span-full">
                Сначала создайте карту в редакторе карт.
                <div className="mt-3"><PxBtn color="teal" onClick={() => setScreen('mapEditor')}>{Ic.map(14)} В редактор карт</PxBtn></div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const deck = cell ? (cell.type === 'trap' ? map.trapCards : map.bonusCards) : [];

  return (
    <div className="h-full crt-grid-bg flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3 border-b-[3px] border-edge bg-[rgba(7,9,18,0.7)] flex-wrap">
        <GhostBtn onClick={() => { setMap(null); setSelCell(null); }}>{Ic.back(14)} Карты</GhostBtn>
        <h1 className="font-display text-lg uppercase tracking-wider text-magma flex items-center gap-2">{Ic.cart(18)} {map.name}</h1>
        {map.ready && <span className="tick-label text-teal">Готова к игре</span>}
        <div className="ml-auto flex gap-2">
          <GhostBtn onClick={() => void persist(map)}>{Ic.save(14)} Сохранить</GhostBtn>
          <PxBtn color={issues.length ? 'dim' : 'magma'} onClick={() => void completeMap()}>{Ic.check(14)} Завершить карту</PxBtn>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <div className="flex-1 min-w-0 relative">
          <canvas
            ref={canvasRef}
            className="w-full h-full block cursor-pointer"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              if (e.button === 1 || e.button === 2) {
                dragRef.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
              } else {
                pickCell(e);
              }
            }}
            onPointerMove={(e) => {
              if (dragRef.current) {
                const d = dragRef.current;
                setView((v) => ({ ...v, x: d.vx - (e.clientX - d.sx) / v.zoom, y: d.vy - (e.clientY - d.sy) / v.zoom }));
              }
            }}
            onPointerUp={() => { dragRef.current = null; }}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={(e) => setView((v) => ({ ...v, zoom: Math.min(3, Math.max(0.25, v.zoom * Math.exp(-e.deltaY * 0.0012))) }))}
          />
          <div className="absolute bottom-3 left-3 hud-chip pixel-corners px-3 py-2 text-[11px] text-dim">
            Клик по ячейке — редактировать · ПКМ — камера · колесо — зум
          </div>
        </div>

        {/* панель ячейки */}
        <div className="w-full lg:w-[360px] shrink-0 border-t-[3px] lg:border-t-0 lg:border-l-[3px] border-edge bg-[rgba(11,14,28,0.8)] overflow-y-auto p-4 space-y-4">
          {!cell ? (
            <div className="text-center py-10">
              <span className="text-magma inline-block floaty">{Ic.target(44)}</span>
              <p className="font-display uppercase text-paper mt-3">Ячейка не выбрана</p>
              <p className="text-[12px] text-dim mt-1">Кликните по ячейке на карте</p>
            </div>
          ) : (
            <>
              <Panel title={`Ячейка №${cell.n}`} icon={Ic.target(16)} accent={cell.type === 'bonus' ? 'var(--color-teal)' : cell.type === 'trap' ? 'var(--color-coral)' : 'var(--color-gold)'}>
                <div className="p-3 space-y-3">
                  <div className="flex gap-1">
                    {(['task', 'bonus', 'trap', 'quiz'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => void setCellType(t)}
                        className={`flex-1 py-1.5 font-display text-[9px] uppercase tracking-wide border-2 transition-colors cursor-pointer ${cell.type === t ? (t === 'bonus' ? 'border-teal text-teal bg-teal/10' : t === 'trap' ? 'border-coral text-coral bg-coral/10' : t === 'quiz' ? 'border-sky text-sky bg-sky/10' : 'border-gold text-gold bg-gold/10') : 'border-edge text-faint hover:text-dim'}`}
                      >
                        {t === 'task' ? 'Задание' : t === 'bonus' ? 'Бонус' : t === 'trap' ? 'Ловушка' : 'Квиз'}
                      </button>
                    ))}
                  </div>
                  <GhostBtn className="w-full" onClick={() => void delCell()}>{Ic.trash(13)} Удалить ячейку из маршрута</GhostBtn>
                </div>
              </Panel>

              {/* оформление «как в монополии» */}
              <Panel title="Оформление ячейки" icon={Ic.pen(16)} accent="var(--color-gold)">
                <div className="p-3 space-y-3">
                  <Field label="Короткое название (видно на карте)">
                    <input className="field-in w-full px-3 py-2 text-sm" maxLength={12} placeholder="Например: БОСС" value={vLabel} onChange={(e) => setVLabel(e.target.value)} />
                  </Field>
                  <Field label="Цвет группы">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {CELL_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => { setVColor(vColor === c ? '' : c); sfx.hover(); }}
                          aria-label={c}
                          className={`w-7 h-7 border-2 cursor-pointer transition-transform hover:scale-110 ${vColor === c ? 'border-paper scale-110' : 'border-abyss'}`}
                          style={{ background: c }}
                        />
                      ))}
                      <button
                        onClick={() => { setVColor(''); sfx.hover(); }}
                        className="w-7 h-7 border-2 border-edge text-faint font-pixel text-[8px] cursor-pointer hover:text-coral"
                        title="Без цвета"
                      >
                        ∅
                      </button>
                    </div>
                  </Field>
                  <Field label="Картинка ячейки (видно на карте)">
                    <div className="flex items-center gap-2">
                      <label className="btn-ghost pixel-corners px-3 py-2 text-[11px] uppercase font-display cursor-pointer inline-flex items-center gap-2">
                        {Ic.upload(13)} Загрузить
                        <input type="file" accept="image/*" className="hidden" onChange={(e) => { void onImg(setVImg)(e.target.files); e.target.value = ''; }} />
                      </label>
                      {vImg && <img src={vImg} alt="" className="h-10 w-10 object-cover border-2 border-edge" />}
                      {vImg && <GhostBtn small onClick={() => setVImg('')}>{Ic.trash(12)}</GhostBtn>}
                    </div>
                  </Field>
                  <PxBtn className="w-full" onClick={() => void saveVisuals()}>{Ic.check(14)} Сохранить оформление</PxBtn>
                </div>
              </Panel>

              {cell.type === 'quiz' ? (
                <Panel title="Квиз-ячейка" icon={Ic.dice(16)} accent="var(--color-sky)">
                  <div className="p-3 space-y-3">
                    <p className="text-[12px] text-dim leading-relaxed">
                      Игрок, вставший сюда, получает случайный квиз из колоды карты. Вопросы создаются в отдельном
                      редакторе — там же настраиваются типы (выбор из 4, текст, музыка, «кот в мешке»), время на ответ и картинки.
                    </p>
                    <div className="hud-chip pixel-corners px-3 py-2 text-[12px] text-sky">
                      Квизов на карте: {(map.quizzes ?? []).length}
                    </div>
                    <PxBtn color="sky" className="w-full" onClick={() => setScreen('quizEditor')}>
                      {Ic.dice(14)} Открыть редактор квизов
                    </PxBtn>
                  </div>
                </Panel>
              ) : cell.type === 'task' ? (
                <Panel title="Задание ячейки" icon={Ic.cart(16)}>
                  <div className="p-3 space-y-3">
                    <Field label={`Ром · в библиотеке ${roms.length}`}>
                      <select className="field-in w-full px-2 py-2 text-sm" value={fRom} onChange={(e) => { setFRom(e.target.value); setFSave(''); }}>
                        <option value="">— выберите ром —</option>
                        {roms.map((r) => <option key={r.id} value={r.id}>{r.name}{r.ext !== 'nes' ? ' (SEGA)' : ''}</option>)}
                      </select>
                    </Field>
                    {roms.length === 0 && (
                      <p className="text-[11px] text-magma">Ромов пока нет — загрузите их в «Запуске эмулятора».</p>
                    )}
                    <Field label={`Сохранение · ${romSaves.length}`}>
                      <select className="field-in w-full px-2 py-2 text-sm" value={fSave} onChange={(e) => setFSave(e.target.value)}>
                        <option value="">— без сохранения (старт с начала) —</option>
                        {romSaves.map((s) => <option key={s.id} value={s.id}>Слот {s.slot} · {s.name}</option>)}
                      </select>
                    </Field>
                    {fRom && romSaves.length === 0 && (
                      <p className="text-[11px] text-gold">
                        У этого рома нет сохранений — запустите его в эмуляторе и запишите состояния (и для NES, и для SEGA).
                      </p>
                    )}

                    <Field label="Название ячейки">
                      <input className="field-in w-full px-3 py-2 text-sm" placeholder="Например: Felix — уровень 3" value={fTitle} onChange={(e) => setFTitle(e.target.value)} />
                    </Field>
                    <Field label="Описание задания">
                      <textarea className="field-in w-full px-3 py-2 text-sm h-20 resize-none" placeholder="Пройти уровень, не теряя жизней…" value={fDesc} onChange={(e) => setFDesc(e.target.value)} />
                    </Field>
                    <Field label="Картинка ячейки (необязательно)">
                      <div className="flex items-center gap-2">
                        <label className="btn-ghost pixel-corners px-3 py-2 text-[11px] uppercase font-display cursor-pointer inline-flex items-center gap-2">
                          {Ic.upload(13)} Загрузить
                          <input type="file" accept="image/*" className="hidden" onChange={(e) => { void onImg(setFImg)(e.target.files); e.target.value = ''; }} />
                        </label>
                        {fImg && <img src={fImg} alt="" className="h-10 w-16 object-cover border-2 border-edge" />}
                      </div>
                    </Field>
                    <PxBtn className="w-full" onClick={() => void saveTask()}>{Ic.check(14)} Сохранить задание</PxBtn>
                    {cell.task && (
                      <div className="text-[11px] text-teal">Сейчас: «{cell.task.title}» · {romName(cell.task.romId)}</div>
                    )}
                  </div>
                </Panel>
              ) : (
                <Panel
                  title={`Колода «${cell.type === 'bonus' ? 'Бонусы' : 'Ловушки'}» · ${deck.length}`}
                  icon={cell.type === 'bonus' ? Ic.star(16) : Ic.skull(16)}
                  accent={cell.type === 'bonus' ? 'var(--color-teal)' : 'var(--color-coral)'}
                >
                  <div className="p-3 space-y-2">
                    {deck.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 border-2 border-edge bg-[rgba(0,0,0,0.25)] px-2.5 py-2">
                        {c.imageId
                          ? <CardThumb id={c.imageId} />
                          : <img src={cardArt(c.kind, c.name)} alt="" className="w-11 h-8 object-cover border border-edge" />}
                        <div className="min-w-0 flex-1">
                          <div className="font-display text-[11px] uppercase text-paper truncate">{c.name}</div>
                          <div className="text-[10px] text-dim leading-tight">{effectLabel(c.effect)}</div>
                        </div>
                        <button onClick={() => void delCard(c.id)} className="text-faint hover:text-coral cursor-pointer shrink-0" aria-label="Удалить карточку">{Ic.trash(14)}</button>
                      </div>
                    ))}
                    {deck.length === 0 && (
                      <p className="text-[11px] text-dim">Колода пуста. Пока в ней нет карточек, ячейка «{cell.type === 'bonus' ? 'Бонус' : 'Ловушка'}» не сработает — а завершить карту с пустой колодой нельзя.</p>
                    )}
                    <div className="border-t-2 border-edge pt-3 space-y-2.5">
                      <div className="tick-label text-gold">Новая карточка</div>
                      <Field label="Эффект">
                        <select className="field-in w-full px-2 py-2 text-[12px]" value={cType} onChange={(e) => {
                          const t = e.target.value as EffectType;
                          setCType(t);
                          const meta = EFFECTS.find((x) => x.key === t)!;
                          setCValue(meta.def || 1);
                        }}>
                          {EFFECTS.map((ef) => <option key={ef.key} value={ef.key}>{ef.label}</option>)}
                        </select>
                      </Field>
                      {EFFECTS.find((x) => x.key === cType)?.hasValue && (
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-dim">{EFFECTS.find((x) => x.key === cType)?.unit}</span>
                          <Stepper value={cValue} onChange={setCValue} min={-20} max={60} />
                        </div>
                      )}
                      {EFFECTS.find((x) => x.key === cType)?.hasTarget && (
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-dim">Номер игрока</span>
                          <Stepper value={cTarget} onChange={setCTarget} min={1} max={4} suffix=" иг." />
                        </div>
                      )}
                      <Field label="Название карточки">
                        <input className="field-in w-full px-3 py-2 text-sm" placeholder="Отпуск на Гавайях" value={cName} onChange={(e) => setCName(e.target.value)} />
                      </Field>
                      <Field label="Описание (необязательно)">
                        <input className="field-in w-full px-3 py-2 text-sm" value={cDesc} onChange={(e) => setCDesc(e.target.value)} />
                      </Field>
                      <Field label="Картинка карточки (необязательно)">
                        <div className="flex items-center gap-2">
                          <label className="btn-ghost pixel-corners px-3 py-2 text-[11px] uppercase font-display cursor-pointer inline-flex items-center gap-2">
                            {Ic.upload(13)} Загрузить
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => { void onImg(setCImg)(e.target.files); e.target.value = ''; }} />
                          </label>
                          {cImg && <img src={cImg} alt="" className="h-10 w-14 object-cover border-2 border-edge" />}
                        </div>
                      </Field>
                      <PxBtn color={cell.type === 'bonus' ? 'teal' : 'coral'} className="w-full" onClick={() => void addCard()}>{Ic.check(14)} Добавить в колоду</PxBtn>
                    </div>
                  </div>
                </Panel>
              )}

              <Panel title="Проверка карты" icon={Ic.check(16)} accent={issues.length ? 'var(--color-coral)' : 'var(--color-teal)'}>
                <div className="p-3 space-y-1.5 text-[11px]">
                  {issues.map((s, i) => <div key={i} className="text-coral">✖ {s}</div>)}
                  {warns.map((s, i) => <div key={i} className="text-magma">▲ {s}</div>)}
                  {!issues.length && !warns.length && <div className="text-teal">✔ Всё в порядке — карту можно завершать</div>}
                  {!issues.length && warns.length > 0 && <div className="text-teal">✔ Завершение доступно</div>}
                </div>
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CardThumb({ id }: { id: string }) {
  const url = useBlobImageUrl(id);
  return url ? <img src={url} alt="" className="w-11 h-8 object-cover border border-edge" /> : <span className="w-11 h-8 bg-panel inline-block border border-edge" />;
}

import { idbGet } from '../db';
import { useEffect as useEff2, useState as useSt2 } from 'react';
function useBlobImageUrl(id: string): string | null {
  const [u, setU] = useSt2<string | null>(null);
  useEff2(() => {
    let on = true;
    idbGet<string>('blobs', id).then((v) => { if (on) setU(v ?? null); });
    return () => { on = false; };
  }, [id]);
  return u;
}
