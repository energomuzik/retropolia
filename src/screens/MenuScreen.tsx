import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import type { Screen } from '../store';
import { Ic } from '../ui';
import { sfx } from '../sound';
import { drawBoard, CELL, cellCenter } from '../render';
import { builtinTiles } from '../assets';
import type { GameMap, TileDef } from '../types';
import { PLAYER_COLORS } from '../types';

const MENU: { key: string; label: string; screen: Screen; desc: string; color: string; icon: (s?: number) => React.ReactNode }[] = [
  { key: 'create', label: 'Создать игру', screen: 'create', desc: 'выбрать карту · открыть комнату', color: '#ffcf3f', icon: Ic.dice },
  { key: 'join', label: 'Подключиться', screen: 'join', desc: 'войти в комнату по коду', color: '#5aa9ff', icon: Ic.globe },
  { key: 'load', label: 'Загрузить игру', screen: 'load', desc: 'сохранённые партии', color: '#8f97c9', icon: Ic.save },
  { key: 'editors', label: 'Все редакторы', screen: 'editorsHub', desc: 'карты · тайлы · задания · квизы · фишки', color: '#2ee6a8', icon: Ic.pen },
  { key: 'emulator', label: 'Запуск эмулятора', screen: 'emulator', desc: 'тест ромов · запись сохранений', color: '#ff5d73', icon: Ic.chip },
  { key: 'options', label: 'Опции', screen: 'options', desc: 'имя · трансляция · звук', color: '#8f97c9', icon: Ic.gear },
];

/** Маленькая демо-карта для заставки: кольцо ячеек вокруг «квартала» из тайлов. */
function makeDemoMap(): GameMap {
  const bt = builtinTiles();
  const byId = new Map(bt.map((t) => [t.name, t]));
  const pick = (n: string) => byId.get(n) ?? bt[0];
  const tiles = [];
  const g1 = pick('grass');
  for (let x = 3; x <= 7; x++) for (let y = 2; y <= 5; y++) tiles.push({ x, y, tileId: g1.id, rot: ((x * 7 + y * 3) % 4) });
  const rd = pick('road');
  for (let x = 4; x <= 6; x++) tiles.push({ x, y: 1, tileId: rd.id, rot: 0 });
  const cells = [];
  let n = 1;
  for (let x = 2; x <= 8; x++) cells.push({ n: n++, x, y: 1, type: 'task' as const, task: null });
  for (let y = 2; y <= 5; y++) cells.push({ n: n++, x: 8, y, type: (y === 3 ? 'bonus' : 'task') as 'task' | 'bonus', task: null });
  for (let x = 8; x >= 2; x--) cells.push({ n: n++, x, y: 5, type: (x === 5 ? 'trap' : 'task') as 'task' | 'trap', task: null });
  for (let y = 4; y >= 2; y--) cells.push({ n: n++, x: 2, y, type: 'task' as const, task: null });
  return {
    id: 'demo', name: 'DEMO', cols: 11, rows: 7, tiles, cells,
    bonusCards: [], trapCards: [], quizzes: [], ready: true, createdAt: 0, updatedAt: 0,
  };
}

/** Attract mode: камера медленно облетает демо-карту, токены-боты шагают по кольцу. */
function useAttract(map: GameMap, tiles: TileDef[]) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ x: 0, y: 0, zoom: 1.4 });
  const bots = useRef(
    PLAYER_COLORS.map((color, i) => ({
      pos: (i * 4) % map.cells.length,
      disp: { x: 0, y: 0 },
      last: 0,
      color,
    })),
  );
  useEffect(() => {
    let raf = 0;
    const tileById = new Map(tiles.map((t) => [t.id, t]));
    const loop = (t: number) => {
      const cv = canvasRef.current;
      if (cv && cv.clientWidth > 0) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.floor(w * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // камера плавно кружит по карте
        const cx = (map.cols * CELL) / 2 + Math.sin(t / 9000) * CELL * 1.6;
        const cy = (map.rows * CELL) / 2 + Math.cos(t / 7000) * CELL * 1.1;
        const zoom = Math.min(w, h) / (CELL * 6.4) + Math.sin(t / 11000) * 0.05;
        const v = view.current;
        v.x += (cx - v.x) * 0.02;
        v.y += (cy - v.y) * 0.02;
        v.zoom += (zoom - v.zoom) * 0.02;

        // боты шагают по кольцу
        for (const b of bots.current) {
          if (t - b.last > 950) {
            b.last = t;
            b.pos = (b.pos + 1 + Math.floor(Math.random() * 2)) % map.cells.length;
          }
          const c = cellCenter(map, b.pos);
          if (b.disp.x === 0 && b.disp.y === 0) { b.disp.x = c.x; b.disp.y = c.y; }
          b.disp.x += (c.x - b.disp.x) * 0.08;
          b.disp.y += (c.y - b.disp.y) * 0.08;
        }
        const activeBot = bots.current[Math.floor(t / 4000) % bots.current.length];

        drawBoard(ctx, map, {
          view: v, width: w, height: h, tileById,
          captured: { 3: 'b0', 9: 'b1' },
          colorById: { b0: PLAYER_COLORS[0], b1: PLAYER_COLORS[1] },
          currentCell: activeBot.pos,
          showNumbers: false,
          tokens: bots.current.map((b) => ({ x: b.disp.x, y: b.disp.y, color: b.color, active: b === activeBot, alive: true, label: '' })),
          time: t, hoverCell: null,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [map, tiles]);
  return canvasRef;
}

export default function MenuScreen() {
  const { setScreen, tiles } = useApp();
  const [sel, setSel] = useState(0);
  const demoMap = useMemo(() => makeDemoMap(), []);
  const demoTiles = useMemo<TileDef[]>(() => (tiles.length ? tiles : builtinTiles()), [tiles]);
  const canvasRef = useAttract(demoMap, demoTiles);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { sfx.hover(); setSel((s) => (s + 1) % MENU.length); }
      else if (e.key === 'ArrowUp') { sfx.hover(); setSel((s) => (s - 1 + MENU.length) % MENU.length); }
      else if (e.key === 'Enter') { sfx.coin(); setScreen(MENU[sel].screen); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, setScreen]);

  return (
    <div className="h-full crt-grid-bg relative overflow-hidden">
      <div className="absolute inset-0 starfield opacity-60 pointer-events-none" />
      <div className="relative z-10 h-full max-w-6xl mx-auto px-6 py-6 flex flex-col">
        <div className="grid lg:grid-cols-[340px_1fr] gap-8 flex-1 min-h-0 items-center">
          {/* левая колонка: логотип + меню */}
          <div className="flex flex-col min-h-0">
            <div className="text-center lg:text-left">
              <h1 className="font-pixel text-gold title-glow glow-throb leading-none text-[38px] sm:text-[48px] tracking-tight">
                RETRO<span className="text-paper">POLIA</span>
              </h1>
              <p className="mt-3 font-display text-dim uppercase tracking-[0.24em] text-[11px] sm:text-xs">
                Настольная игра, где вместо денег — твой скилл
              </p>
            </div>

            <nav className="mt-6 space-y-1.5">
              {MENU.map((item, i) => (
                <button
                  key={item.key}
                  onMouseEnter={() => { setSel(i); sfx.hover(); }}
                  onClick={() => { sfx.coin(); setScreen(item.screen); }}
                  className={`menu-row w-full text-left flex items-center gap-4 px-4 py-2.5 cursor-pointer ${sel === i ? 'active' : ''}`}
                  style={{ ['--rowc' as string]: item.color }}
                >
                  <span className={`shrink-0 transition-transform ${sel === i ? 'scale-125' : 'opacity-70'}`} style={{ color: item.color }}>
                    {item.icon(20)}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className={`block font-display uppercase tracking-wide text-[15px] ${sel === i ? 'text-paper' : 'text-dim'}`}>
                      {item.label}
                    </span>
                    <span className="block tick-label text-faint text-[8px] mt-0.5">{item.desc}</span>
                  </span>
                  <span className={`font-pixel text-[10px] transition-opacity ${sel === i ? 'opacity-100' : 'opacity-0'}`} style={{ color: item.color }}>
                    ▶
                  </span>
                </button>
              ))}
            </nav>

            <div className="mt-5 text-center lg:text-left">
              <p className="font-pixel text-[9px] text-faint blink-hard">INSERT SKILL TO CONTINUE</p>
            </div>
          </div>

          {/* правая колонка: демо-режим */}
          <div className="hidden lg:flex flex-col min-h-0">
            <div className="relative border-[3px] border-edge2 bg-[#05070f] shadow-[0_0_60px_rgba(255,207,63,0.10),inset_0_0_40px_rgba(0,0,0,0.6)] pixel-corners overflow-hidden" style={{ height: 'min(58vh, 520px)' }}>
              <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-3 py-1.5 bg-[rgba(7,9,18,0.75)] border-b-2 border-edge">
                <span className="font-pixel text-[8px] text-gold flex items-center gap-2">
                  <span className="w-2 h-2 bg-coral blink-hard inline-block" />
                  ATTRACT MODE · DEMO
                </span>
                <span className="font-pixel text-[8px] text-faint">2P READY</span>
              </div>
              <canvas ref={canvasRef} className="w-full h-full block pt-6" />
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 font-pixel text-[8px] text-dim">
                БРОСАЙ КУБИКИ · ПРОХОДИ ЗАДАНИЯ NES И SEGA · ЗАХВАТЫВАЙ КЛЕТКИ
              </div>
            </div>
          </div>
        </div>

        {/* нижняя строка */}
        <div className="shrink-0 flex items-center justify-between mt-4 pt-3 border-t-2 border-edge">
          <span className="font-pixel text-[8px] text-faint">v1.0 · 2–4 ИГРОКА · ОНЛАЙН</span>
          <span className="font-pixel text-[8px] text-faint">© ENERGO MUZHIK STUDIOS</span>
        </div>
      </div>
    </div>
  );
}
