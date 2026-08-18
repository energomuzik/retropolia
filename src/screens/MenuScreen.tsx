import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import type { Screen } from '../store';
import { Ic } from '../ui';
import { drawBoard, fitView, cellCenter } from '../render';
import type { GameMap, PlacedTile, CellDef } from '../types';
import { sfx } from '../sound';

const MENU: { key: string; label: string; screen: Screen; desc: string; color: string; icon: (s?: number) => React.ReactNode }[] = [
  { key: 'create', label: 'Создать игру', screen: 'create', desc: 'выбрать карту · открыть комнату', color: '#ffcf3f', icon: Ic.dice },
  { key: 'join', label: 'Подключиться', screen: 'join', desc: 'войти в комнату по коду', color: '#5aa9ff', icon: Ic.globe },
  { key: 'load', label: 'Загрузить игру', screen: 'load', desc: 'сохранённые партии', color: '#8f97c9', icon: Ic.save },
  { key: 'mapEditor', label: 'Редактор карт', screen: 'mapEditor', desc: 'тайлы · ячейки · маршрут', color: '#2ee6a8', icon: Ic.map },
  { key: 'tileEditor', label: 'Редактор тайлов', screen: 'tileEditor', desc: 'загрузка своих тайлов', color: '#35d46f', icon: Ic.grid },
  { key: 'taskEditor', label: 'Редактор заданий', screen: 'taskEditor', desc: 'ромы · сохранки · карточки', color: '#ff8b3f', icon: Ic.cart },
  { key: 'emulator', label: 'Запуск эмулятора', screen: 'emulator', desc: 'тест ромов · запись сохранений', color: '#ff5d73', icon: Ic.chip },
  { key: 'options', label: 'Опции', screen: 'options', desc: 'имя · трансляция · звук', color: '#8f97c9', icon: Ic.gear },
];

const TIPS = [
  'ДЕРЖИ КНОПКУ КУБИКОВ — ПЕРЕМЕШИВАЙ СИЛЬНЕЕ',
  '60 МИНУТ И 60 ПОПЫТОК НА СТАРТЕ. БЕРЕГИ ИХ',
  'СОПЕРНИК НА ТВОЕЙ ЯЧЕЙКЕ? ЕГО РЕСУРСЫ — ТЕБЕ',
  'ПРОПУСК ЗАДАНИЯ ДОСТУПЕН ПОСЛЕ 5 ПОТРАЧЕННЫХ РЕСУРСОВ',
  'СОЗДАВАЙ НОВЫЕ ЗАДАНИЯ ПРЯМО ВО ВРЕМЯ ПАРТИИ',
  'ЛОВУШКИ И БОНУСЫ СОЗДАЮТСЯ В РЕДАКТОРЕ ЗАДАНИЙ',
  'INSERT COIN TO CONTINUE',
];

function buildDemoMap(tileIds: string[]): GameMap {
  const cols = 9, rows = 7;
  const tiles: PlacedTile[] = [];
  const grass = tileIds[0] ?? '';
  const road = tileIds[2] ?? tileIds[0] ?? '';
  const roadV = tileIds[3] ?? road;
  const water = tileIds[5] ?? grass;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const ring = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      let id = grass;
      if ((x === 2 && y === 2) || (x === 6 && y === 4) || (x === 5 && y === 2)) id = water;
      tiles.push({ x, y, tileId: id, rot: 0 });
    }
  // дорожное кольцо
  const idx = (x: number, yy: number) => yy * cols + x;
  for (let x = 1; x < cols - 1; x++) { tiles[idx(x, 1)].tileId = road; tiles[idx(x, rows - 2)].tileId = road; }
  for (let yy = 2; yy < rows - 2; yy++) { tiles[idx(1, yy)].tileId = roadV; tiles[idx(cols - 2, yy)].tileId = roadV; }
  const loop: [number, number][] = [];
  for (let x = 1; x <= cols - 2; x++) loop.push([x, 1]);
  for (let yy = 2; yy <= rows - 2; yy++) loop.push([cols - 2, yy]);
  for (let x = cols - 3; x >= 1; x--) loop.push([x, rows - 2]);
  for (let yy = rows - 3; yy >= 2; yy--) loop.push([1, yy]);
  const cells: CellDef[] = loop.map(([x, yy], i) => ({
    n: i + 1, x, y: yy,
    type: i === 4 || i === 12 ? 'bonus' : i === 8 || i === 16 ? 'trap' : 'task',
    task: null,
  }));
  return {
    id: 'demo', name: 'DEMO', cols, rows, tiles, cells,
    bonusCards: [], trapCards: [], ready: true, createdAt: 0, updatedAt: 0,
  };
}

export default function MenuScreen() {
  const { tiles, setScreen, netInfo } = useApp();
  const [sel, setSel] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const demo = useMemo(() => buildDemoMap(tiles.filter((t) => t.builtin).map((t) => t.id).length ? tiles.map((t) => t.id) : []), [tiles]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { sfx.hover(); setSel((s) => (s + 1) % MENU.length); }
      else if (e.key === 'ArrowUp') { sfx.hover(); setSel((s) => (s - 1 + MENU.length) % MENU.length); }
      else if (e.key === 'Enter') { sfx.coin(); setScreen(MENU[sel].screen); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, setScreen]);

  useEffect(() => {
    let raf = 0;
    let tokenA = 0, tokenB = 9;
    let dispA = { x: 0, y: 0 };
    let dispB = { x: 0, y: 0 };
    let lastStep = performance.now();
    const loop = (t: number) => {
      const cv = canvasRef.current;
      if (cv && demo.cells.length) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.floor(w * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (t - lastStep > 1100) {
          lastStep = t;
          tokenA = (tokenA + 1 + Math.floor(Math.random() * 6)) % demo.cells.length;
          tokenB = (tokenB + 1 + Math.floor(Math.random() * 6)) % demo.cells.length;
          sfx.step();
        }
        const tA = cellCenter(demo, tokenA);
        const tB = cellCenter(demo, tokenB);
        dispA.x += (tA.x - dispA.x) * 0.09; dispA.y += (tA.y - dispA.y) * 0.09;
        dispB.x += (tB.x - dispB.x) * 0.07; dispB.y += (tB.y - dispB.y) * 0.07;
        if (dispA.x === 0) { dispA = { ...tA }; dispB = { ...tB }; }
        const tileById = new Map(tiles.map((tl) => [tl.id, tl]));
        drawBoard(ctx, demo, {
          view: fitView(demo, w, h),
          width: w, height: h,
          tileById,
          captured: { 3: 'a', 11: 'b' },
          colorById: { a: '#ffcf3f', b: '#5aa9ff' },
          currentCell: tokenA,
          showNumbers: false,
          tokens: [
            { x: dispA.x, y: dispA.y, color: '#ffcf3f', active: true, alive: true, label: 'A' },
            { x: dispB.x, y: dispB.y, color: '#5aa9ff', active: false, alive: true, label: 'B' },
          ],
          time: t,
          hoverCell: null,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [demo, tiles]);

  return (
    <div className="h-full crt-grid-bg relative overflow-hidden">
      <div className="absolute inset-0 starfield opacity-60 pointer-events-none" />
      <div className="relative z-10 h-full max-w-6xl mx-auto px-6 py-6 flex flex-col">
        {/* шапка */}
        <div className="flex items-end justify-between gap-6 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-teal">{Ic.chip(14)}</span>
              <span className="tick-label text-teal">8-BIT BOARD ARCADE · NES INSIDE</span>
            </div>
            <h1 className="font-pixel text-gold title-glow glow-throb leading-none text-[34px] sm:text-[52px] tracking-tight">
              RETRO<span className="text-paper">POLIA</span>
            </h1>
            <p className="mt-3 font-display text-dim uppercase tracking-[0.22em] text-[11px] sm:text-xs">
              Монополия, где вместо денег — ретро-челленджи
            </p>
          </div>
          <div className="hud-chip pixel-corners px-4 py-2.5 flex items-center gap-3 mb-2">
            <span className={`w-2.5 h-2.5 ${netInfo.online ? 'bg-teal' : 'bg-gold'} pulse-ring`} />
            <div className="text-[11px] leading-tight">
              <div className="font-display uppercase text-paper">{netInfo.online ? 'Онлайн-канал активен' : 'Канал: локальные вкладки'}</div>
              <div className="text-dim">PeerJS + BroadcastChannel</div>
            </div>
          </div>
        </div>

        {/* тело */}
        <div className="mt-6 flex-1 min-h-0 grid lg:grid-cols-[1fr_1.15fr] gap-6">
          <nav className="flex flex-col justify-center gap-0.5" aria-label="Главное меню">
            {MENU.map((m, i) => (
              <button
                key={m.key}
                onMouseEnter={() => { sfx.hover(); setSel(i); }}
                onClick={() => { sfx.coin(); setScreen(m.screen); }}
                className={`menu-row flex items-center gap-4 px-4 py-[9px] text-left cursor-pointer ${sel === i ? 'active' : ''}`}
                style={{ ['--rowc' as string]: m.color }}
              >
                <span className={`shrink-0 transition-transform ${sel === i ? 'scale-110' : ''}`} style={{ color: m.color }}>
                  {m.icon(22)}
                </span>
                <span className="flex-1">
                  <span className={`block font-display uppercase tracking-wider text-[15px] transition-colors ${sel === i ? 'text-paper' : 'text-dim'}`}>
                    {m.label}
                  </span>
                  <span className="block text-[10px] font-pixel text-faint mt-0.5 lowercase">{m.desc}</span>
                </span>
                {sel === i && <span className="font-pixel text-[10px] blink-hard" style={{ color: m.color }}>▶</span>}
              </button>
            ))}
          </nav>

          <div className="relative min-h-[240px] lg:min-h-0">
            <div className="absolute inset-0 pixel-panel pixel-corners overflow-hidden">
              <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-3 py-1.5 bg-[rgba(7,9,18,0.72)] border-b-2 border-edge">
                <span className="tick-label text-gold">Attract mode · демо-поле</span>
                <span className="tick-label text-faint">2P DEMO</span>
              </div>
              <canvas ref={canvasRef} className="w-full h-full block" />
            </div>
          </div>
        </div>

        {/* бегущая строка */}
        <div className="mt-5 border-y-2 border-edge bg-[rgba(7,9,18,0.6)] overflow-hidden py-2">
          <div className="marquee-x whitespace-nowrap font-pixel text-[9px] text-dim">
            {[0, 1].map((k) => (
              <span key={k}>
                {TIPS.map((t, i) => (
                  <span key={i} className="mx-6">
                    <span className="text-gold">◆</span> {t}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between mt-2 pb-1">
          <span className="tick-label text-faint">RETROPOLIA v1.0 · локальная библиотека в IndexedDB</span>
          <span className="tick-label text-faint">© 8-BIT DREAMS</span>
        </div>
      </div>
    </div>
  );
}
