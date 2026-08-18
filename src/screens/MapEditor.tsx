import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { GhostBtn, Ic, Modal, Panel, PxBtn, Stepper } from '../ui';
import { CELL, boardSize, drawBoard, fitView } from '../render';
import { idbDel, idbPut, uid } from '../db';
import type { GameMap } from '../types';
import { sfx } from '../sound';

type Tool = 'paint' | 'erase' | 'rotate' | 'cell' | 'type' | 'pan';

const TOOLS: { key: Tool; label: string; hint: string }[] = [
  { key: 'paint', label: 'Тайл', hint: 'красить клетки выбранным тайлом' },
  { key: 'rotate', label: 'Поворот', hint: 'крутить тайл на 90° (или клавиша R)' },
  { key: 'erase', label: 'Ластик', hint: 'убирать тайлы' },
  { key: 'cell', label: 'Ячейка', hint: 'клик — поставить ячейку маршрута, повторный клик — убрать' },
  { key: 'type', label: 'Тип', hint: 'переключать тип ячейки: задание → бонус → ловушка' },
  { key: 'pan', label: 'Рука', hint: 'двигать камеру (колесо — масштаб)' },
];

export default function MapEditor() {
  const { maps, tiles, setScreen, refresh, toast } = useApp();
  const [map, setMap] = useState<GameMap | null>(null);
  const [tool, setTool] = useState<Tool>('paint');
  const [tileId, setTileId] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [hover, setHover] = useState<{ cx: number; cy: number } | null>(null);
  const [nameModal, setNameModal] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const paintRef = useRef<string>('');
  const viewRef = useRef(view);
  viewRef.current = view;
  const mapRef = useRef(map);
  mapRef.current = map;

  const tileById = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);

  useEffect(() => {
    if (!tileId && tiles.length) setTileId(tiles[0].id);
  }, [tiles, tileId]);

  const openMap = (m: GameMap) => {
    const copy = JSON.parse(JSON.stringify(m)) as GameMap;
    setMap(copy);
    setTool('paint');
    const cv = canvasRef.current;
    const w = cv?.clientWidth ?? 800, h = cv?.clientHeight ?? 500;
    setView(fitView(copy, w, h));
    sfx.coin();
  };

  const newMap = () => {
    const m: GameMap = {
      id: uid('map'), name: 'Новая карта', cols: 12, rows: 9,
      tiles: [], cells: [], bonusCards: [], trapCards: [],
      ready: false, createdAt: Date.now(), updatedAt: Date.now(),
    };
    openMap(m);
  };

  const mutate = (fn: (m: GameMap) => void) => {
    setMap((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as GameMap;
      fn(next);
      next.updatedAt = Date.now();
      return next;
    });
  };

  const cellAt = (m: GameMap, cx: number, cy: number) => m.cells.findIndex((c) => c.x === cx && c.y === cy);

  const applyTool = (cx: number, cy: number) => {
    const m = mapRef.current;
    if (!m || cx < 0 || cy < 0 || cx >= m.cols || cy >= m.rows) return;
    const key = `${tool}:${cx}:${cy}`;
    if (paintRef.current === key && (tool === 'cell' || tool === 'type' || tool === 'rotate')) return;
    paintRef.current = key;
    switch (tool) {
      case 'paint': {
        if (!tileId) return;
        mutate((mm) => {
          const ex = mm.tiles.find((t) => t.x === cx && t.y === cy);
          if (ex) { ex.tileId = tileId; }
          else mm.tiles.push({ x: cx, y: cy, tileId, rot: 0 });
        });
        break;
      }
      case 'rotate':
        mutate((mm) => {
          const ex = mm.tiles.find((t) => t.x === cx && t.y === cy);
          if (ex) ex.rot = (ex.rot + 1) % 4;
        });
        break;
      case 'erase':
        mutate((mm) => { mm.tiles = mm.tiles.filter((t) => !(t.x === cx && t.y === cy)); });
        break;
      case 'cell': {
        const idx = cellAt(m, cx, cy);
        mutate((mm) => {
          if (idx >= 0) mm.cells.splice(idx, 1);
          else mm.cells.push({ n: mm.cells.length + 1, x: cx, y: cy, type: 'task', task: null });
          mm.cells = mm.cells.map((c, i) => ({ ...c, n: i + 1 }));
        });
        sfx.step();
        break;
      }
      case 'type': {
        const idx = cellAt(m, cx, cy);
        if (idx < 0) return;
        mutate((mm) => {
          const c = mm.cells[idx];
          c.type = c.type === 'task' ? 'bonus' : c.type === 'bonus' ? 'trap' : 'task';
        });
        sfx.hover();
        break;
      }
      case 'pan':
        break;
    }
  };

  const toCell = (e: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    const v = viewRef.current;
    const wx = v.x + (e.clientX - r.left - r.width / 2) / v.zoom;
    const wy = v.y + (e.clientY - r.top - r.height / 2) / v.zoom;
    return { cx: Math.floor(wx / CELL), cy: Math.floor(wy / CELL) };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'r' && hover) {
        mutate((mm) => {
          const ex = mm.tiles.find((t) => t.x === hover.cx && t.y === hover.cy);
          if (ex) ex.rot = (ex.rot + 1) % 4;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hover]);

  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      const cv = canvasRef.current;
      const m = mapRef.current;
      if (cv && m) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
          cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr);
        }
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawBoard(ctx, m, {
          view: viewRef.current, width: w, height: h,
          tileById, captured: {}, colorById: {},
          currentCell: m.cells.length ? 0 : null,
          showNumbers: true, tokens: [], time: t,
          hoverCell: hover && cellAt(m, hover.cx, hover.cy) >= 0 ? cellAt(m, hover.cx, hover.cy) : null,
        });
        // подсветка клетки под курсором
        if (hover && hover.cx >= 0 && hover.cy >= 0 && hover.cx < m.cols && hover.cy < m.rows) {
          const v = viewRef.current;
          ctx.save();
          ctx.translate(w / 2, h / 2);
          ctx.scale(v.zoom, v.zoom);
          ctx.translate(-v.x, -v.y);
          ctx.strokeStyle = tool === 'cell' ? '#ffcf3f' : tool === 'type' ? '#ff5d73' : '#2ee6a8';
          ctx.lineWidth = 2.5;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(hover.cx * CELL + 2, hover.cy * CELL + 2, CELL - 4, CELL - 4);
          ctx.restore();
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tileById, hover, tool]);

  const saveMap = async (m: GameMap) => {
    await idbPut('maps', m.id, m);
    await refresh();
  };

  const finish = async () => {
    if (!map) return;
    if (map.cells.length < 10) {
      sfx.fail();
      toast(`Нужно минимум 10 ячеек (сейчас ${map.cells.length})`, 'err');
      return;
    }
    setNameDraft(map.ready ? map.name : '');
    setNameModal(true);
  };

  const confirmFinish = async () => {
    if (!map) return;
    const name = nameDraft.trim();
    if (!name) { toast('Введите название карты', 'err'); return; }
    const done = { ...map, name: name.toUpperCase(), ready: map.ready };
    await saveMap(done);
    setNameModal(false);
    sfx.success();
    toast(`Карта «${name}» сохранена`, 'ok');
  };

  const removeMap = async (id: string) => {
    await idbDel('maps', id);
    await refresh();
    if (map?.id === id) setMap(null);
    toast('Карта удалена', 'err');
  };

  const resize = (axis: 'cols' | 'rows', v: number) => {
    mutate((mm) => {
      mm[axis] = v;
      mm.tiles = mm.tiles.filter((t) => t.x < mm.cols && t.y < mm.rows);
      const kept = mm.cells.filter((c) => c.x < mm.cols && c.y < mm.rows);
      mm.cells = kept.map((c, i) => ({ ...c, n: i + 1 }));
    });
  };

  const taskCells = map?.cells.filter((c) => c.type === 'task').length ?? 0;
  const bonusCells = map?.cells.filter((c) => c.type === 'bonus').length ?? 0;
  const trapCells = map?.cells.filter((c) => c.type === 'trap').length ?? 0;

  return (
    <div className="h-full crt-grid-bg flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3 border-b-[3px] border-edge bg-[rgba(7,9,18,0.7)] flex-wrap">
        <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
        <h1 className="font-display text-lg uppercase tracking-wider text-teal flex items-center gap-2">
          {Ic.map(18)} Редактор карт
        </h1>
        {map && <span className="hud-chip pixel-corners px-3 py-1 font-display text-xs text-gold uppercase">{map.name}</span>}
        <div className="ml-auto flex gap-2 flex-wrap">
          {map && (
            <>
              <GhostBtn onClick={() => { void saveMap(map); toast('Черновик сохранён', 'ok'); }}>{Ic.save(14)} Сохранить</GhostBtn>
              <PxBtn color="teal" onClick={() => void finish()}>{Ic.check(14)} Карта создана</PxBtn>
            </>
          )}
          {!map && <PxBtn color="teal" onClick={newMap}>+ Новая карта</PxBtn>}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* левая колонка: карты + палитра */}
        <div className="w-[240px] shrink-0 border-r-[3px] border-edge bg-[rgba(11,14,28,0.75)] overflow-y-auto p-3 space-y-4 hidden md:block">
          <div>
            <div className="tick-label mb-2">Мои карты · {maps.length}</div>
            <div className="space-y-1.5">
              {maps.map((m) => (
                <button
                  key={m.id}
                  onClick={() => openMap(m)}
                  className={`w-full text-left pixel-corners border-2 px-3 py-2 transition-colors cursor-pointer ${map?.id === m.id ? 'border-gold bg-[rgba(255,207,63,0.08)]' : 'border-edge hover:border-edge2 bg-panel'}`}
                >
                  <div className="font-display text-[11px] uppercase text-paper truncate">{m.name}</div>
                  <div className="tick-label text-faint mt-0.5">{m.cells.length} яч. · {m.ready ? 'готова' : 'в работе'}</div>
                </button>
              ))}
              {maps.length === 0 && <div className="text-[11px] text-faint">Пока пусто — создайте первую карту</div>}
            </div>
          </div>
          {map && (
            <>
              <div>
                <div className="tick-label mb-2">Палитра тайлов</div>
                <div className="grid grid-cols-4 gap-1.5">
                  {tiles.map((t) => (
                    <button
                      key={t.id}
                      title={`${t.name} (${t.gw}×${t.gh})`}
                      onClick={() => { setTileId(t.id); setTool('paint'); sfx.hover(); }}
                      className={`aspect-square border-2 overflow-hidden cursor-pointer transition-transform hover:scale-105 ${tileId === t.id ? 'border-gold' : 'border-edge'}`}
                    >
                      <img src={t.dataUrl} alt={t.name} className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="tick-label mb-2">Размер сетки</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Ширина</span><Stepper value={map.cols} onChange={(v) => resize('cols', v)} min={6} max={40} /></div>
                  <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Высота</span><Stepper value={map.rows} onChange={(v) => resize('rows', v)} min={6} max={40} /></div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* центр: холст или заглушка */}
        <div className="flex-1 min-w-0 relative">
          {!map ? (
            <div className="h-full flex flex-col items-center justify-center gap-4 text-center p-6">
              <span className="text-teal floaty">{Ic.map(56)}</span>
              <div className="font-display uppercase text-paper text-lg">Выберите карту или создайте новую</div>
              <p className="text-[13px] text-dim max-w-sm">
                Расставьте тайлы, затем пронумеруйте ячейки маршрута кликами — после ячейки №N маршрут зацикливается на №1, как в монополии.
              </p>
              <div className="flex gap-3">
                <PxBtn color="teal" onClick={newMap}>Новая карта</PxBtn>
                {maps.length > 0 && <GhostBtn onClick={() => openMap(maps[0])}>Открыть «{maps[0].name}»</GhostBtn>}
              </div>
            </div>
          ) : (
            <>
              <canvas
                ref={canvasRef}
                className="w-full h-full block cursor-crosshair"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const { cx, cy } = toCell(e);
                  if (tool === 'pan' || e.button === 1 || e.button === 2) {
                    dragRef.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
                  } else {
                    applyTool(cx, cy);
                  }
                }}
                onPointerMove={(e) => {
                  const { cx, cy } = toCell(e);
                  setHover({ cx, cy });
                  if (dragRef.current) {
                    const d = dragRef.current;
                    setView((v) => ({ ...v, x: d.vx - (e.clientX - d.sx) / v.zoom, y: d.vy - (e.clientY - d.sy) / v.zoom }));
                  } else if (e.buttons === 1 && (tool === 'paint' || tool === 'erase')) {
                    applyTool(cx, cy);
                  }
                }}
                onPointerUp={() => { dragRef.current = null; paintRef.current = ''; }}
                onPointerLeave={() => { setHover(null); dragRef.current = null; }}
                onContextMenu={(e) => e.preventDefault()}
                onWheel={(e) => {
                  setView((v) => ({ ...v, zoom: Math.min(3, Math.max(0.25, v.zoom * Math.exp(-e.deltaY * 0.0012))) }));
                }}
              />
              {/* панель инструментов */}
              <div className="absolute top-3 left-1/2 -translate-x-1/2 flex gap-1 hud-chip pixel-corners p-1.5">
                {TOOLS.map((tl) => (
                  <button
                    key={tl.key}
                    title={tl.hint}
                    onClick={() => { setTool(tl.key); sfx.hover(); }}
                    className={`px-3 py-1.5 font-display text-[10px] uppercase tracking-wide transition-colors cursor-pointer ${tool === tl.key ? 'bg-gold text-abyss' : 'text-dim hover:text-paper'}`}
                  >
                    {tl.label}
                  </button>
                ))}
                <button
                  onClick={() => { const cv = canvasRef.current; if (cv && map) setView(fitView(map, cv.clientWidth, cv.clientHeight)); }}
                  className="px-3 py-1.5 font-display text-[10px] uppercase text-sky hover:text-paper cursor-pointer"
                  title="Показать всю карту"
                >
                  Вся карта
                </button>
              </div>
              {/* статус */}
              <div className="absolute bottom-3 left-3 hud-chip pixel-corners px-3 py-2 text-[11px] space-y-0.5">
                <div className={`font-display uppercase ${map.cells.length >= 10 ? 'text-teal' : 'text-gold'}`}>
                  Ячейки: {map.cells.length} / мин. 10
                </div>
                <div className="text-dim">Задания: {taskCells} · <span className="text-teal">Бонус: {bonusCells}</span> · <span className="text-coral">Ловушки: {trapCells}</span></div>
                <div className="text-faint">Тайлов: {map.tiles.length} · {boardSize(map).w / CELL}×{boardSize(map).h / CELL}</div>
              </div>
              <div className="absolute bottom-3 right-3 tick-label text-faint">ЛКМ — инструмент · ПКМ/средняя — камера · колесо — зум · R — поворот</div>
            </>
          )}
        </div>
      </div>

      {nameModal && (
        <Modal title="Карта готова?" icon={Ic.map(16)} onClose={() => setNameModal(false)} w="max-w-md">
          <p className="text-[13px] text-dim mb-4">
            Ячеек: {map?.cells.length} — маршрут зациклится с последней на первую. Название увидят все игроки комнаты.
          </p>
          <input
            autoFocus
            className="field-in w-full px-3 py-2.5 font-display uppercase tracking-wide text-sm"
            placeholder="НАЗВАНИЕ КАРТЫ"
            maxLength={24}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void confirmFinish(); }}
          />
          <div className="flex justify-end gap-3 mt-5">
            <GhostBtn onClick={() => setNameModal(false)}>Назад</GhostBtn>
            <PxBtn color="teal" onClick={() => void confirmFinish()}>{Ic.check(14)} Сохранить карту</PxBtn>
          </div>
        </Modal>
      )}
    </div>
  );
}


