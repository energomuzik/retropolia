import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { AnimPreview, GhostBtn, Ic, Modal, PxBtn, Stepper } from '../ui';
import {
  CELL, mapSize, drawBoard, fitView, cellAtPoint, stampAtPoint, animAtPoint, bossAtPoint, cellBox, cellCenter,
  renumberByPath, normCellsLegacy, fixLinksAfterDelete, startCellIdx,
} from '../render';
import { extractTilesFromImage, scaleTileImg } from '../tilecut';
import type { ExtractInfo } from '../tilecut';
import { idbDel, idbGet, idbPut, uid } from '../db';
import type { AnimDef, BossAnimDef, CellDef, CellType, CustomChallenge, GameMap, PlacedAnim, PlacedBoss, PlateBg, PortalZone, Stamp, TileGrid, TokenDef, TileGroup, TileImg, WallRect } from '../types';
import { bossLibEntryOf, challengeSummaryLines, coinsStr, isJourneyLike, MAP_MODES, MAX_FIELD, PLATE_SIZES, tileRectOf, RUBG_ZONE_PHASES, RUBG_ZONE_TOTAL, rubgFmtZone } from '../types';
import { HoldDeleteButton, rememberDeleted, TileSizeBtns, useKeyDelete } from '../delGuard';
import { sfx } from '../sound';

/* ---------- импорт картинок: сжимаем до разумного размера, чтобы карта не весила десятки МБ ---------- */

async function importImage(file: File, maxSide: number, jpeg = false): Promise<{ url: string; w: number; h: number } | null> {
  if (!file.type.startsWith('image/')) return null;
  const url0 = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url0;
    });
    const k = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
    const w = Math.max(1, Math.round(img.width * k));
    const h = Math.max(1, Math.round(img.height * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d')!;
    cx.imageSmoothingEnabled = true;
    cx.drawImage(img, 0, 0, w, h);
    return { url: jpeg ? cv.toDataURL('image/jpeg', 0.85) : cv.toDataURL('image/png'), w, h };
  } finally {
    URL.revokeObjectURL(url0);
  }
}

function migrateMap(m: GameMap, libTiles: { id: string; dataUrl: string; gw: number; gh: number; name: string }[]): GameMap {
  const next = { ...m } as GameMap;
  // размер поля
  if (next.mw === undefined || next.mh === undefined) {
    next.mw = Math.max(640, (next.mw ?? next.cols * CELL));
    next.mh = Math.max(640, (next.mh ?? next.rows * CELL));
  }
  // ячейки: сетка → свободные центры
  next.cells = next.cells.map((c) => {
    if (c.cx !== undefined && c.cy !== undefined) return c;
    const w = (c.w || 1) * CELL, h = (c.h || 1) * CELL;
    return {
      ...c,
      cx: (c.x + (c.w || 1) / 2) * CELL,
      cy: (c.y + (c.h || 1) / 2) * CELL,
      cw: w,
      ch: h,
    };
  });
  // тайлы из старой библиотеки → штампы внутри карты
  next.tileset = next.tileset ? [...next.tileset] : [];
  next.stamps = next.stamps ? [...next.stamps] : [];
  // палитра без групп (карта до спойлеров) → одна общая группа
  if ((!next.tileGroups || next.tileGroups.length === 0) && next.tileset.length) {
    next.tileGroups = [{ id: uid('tg'), name: 'Тайлы карты', tids: next.tileset.map((t) => t.id) }];
  }
  if (next.tiles.length > 0) {
    for (const pt of next.tiles) {
      const t = libTiles.find((x) => x.id === pt.tileId);
      if (!t) continue;
      let tid = `lib-${t.id}`;
      if (!next.tileset.some((x) => x.id === tid)) {
        next.tileset.push({ id: tid, name: t.name, dataUrl: t.dataUrl });
      }
      const w = t.gw * CELL, h = t.gh * CELL;
      next.stamps.push({
        id: uid('st'), tid,
        x: (pt.x + t.gw / 2) * CELL,
        y: (pt.y + t.gh / 2) * CELL,
        w, h, rot: pt.rot,
      });
    }
    next.tiles = [];
  }
  if (!next.stamps.length && !next.tileset.length) {
    next.tileset = [];
    next.stamps = [];
  }
  renumberByPath(next);
  // старые карты: метки закоулков v0.12.x → безномерные ячейки + стрелки
  normCellsLegacy(next);
  next.updatedAt = Date.now();
  return next;
}

/* ---------- инструменты ---------- */

type Tool = 'select' | 'tile' | 'cell' | 'link' | 'hop' | 'anim' | 'boss' | 'wall' | 'portal' | 'erase' | 'pan';

const TOOLS: { key: Tool; label: string; hint: string }[] = [
  { key: 'select', label: 'Выбор', hint: 'клик — выбрать тайл/ячейку/анимацию и тянуть мышью · пустое место — двигать камеру' },
  { key: 'tile', label: 'Тайл', hint: 'клик — поставить выбранный тайл; можно тянуть с зажатой кнопкой' },
  { key: 'cell', label: 'Ячейка', hint: 'клик — новая ячейка В ЛЮБОМ МЕСТЕ (без привязки к сетке), клик по ячейке — выбрать' },
  { key: 'link', label: 'Стрелка', hint: 'клик по ячейке А, затем по Б. У БЕЗНОМЕРНОЙ ячейки стрелка — куда шагает фишка; у ПРОНУМЕРОВАННОЙ — прыжок при остановке. Клик по той же ячейке — убрать' },
  { key: 'hop', label: 'Переход', hint: 'ВТОРАЯ стрелка: клик по ячейке А, затем по Б — когда фишка ОСТАНОВИТСЯ на А, она прыгнет на Б (выход из круга, штраф-телепорт). Клик по той же ячейке — убрать' },
  { key: 'anim', label: 'Анимация', hint: 'выберите анимацию в левой панели, кликните по карте — поставится проигрыватель анимации. Клик по уже стоящей — выбрать и тянуть' },
  { key: 'boss', label: 'Босс', hint: 'вшейте босса в карту (спойлер «Боссы» слева), выберите его и кликните по карте — босс встанет на ячейку: живёт (idle), реагирует на победы/поражения игроков в радиусе' },
  { key: 'wall', label: 'Стена', hint: 'НЕВИДИМАЯ стена (только JOURNEY): протяните прямоугольник — фишка не сможет зайти внутрь. Клик по стене — выбрать и тянуть. В игре стены НЕ видны' },
  { key: 'portal', label: 'Портал', hint: 'ТЕЛЕПОРТ между плитками: протяните зону входа, затем кликните по карте (можно на другой плитке — переключите её в панели «Плитки и порталы») — куда переносить. В JOURNEY фишка, войдя в зону, мгновенно переносится. Клик по порталу — выбрать и тянуть' },
  { key: 'erase', label: 'Ластик', hint: 'клик или протяни с зажатой кнопкой — убирает ТАЙЛЫ под курсором. Ячейки, анимации и стены ластик не трогает: выдели и нажми Delete' },
  { key: 'pan', label: 'Рука', hint: 'двигать камеру (колесо — зум под курсором)' },
];

const SIZE_PRESETS: { w: number; h: number; label: string }[] = [
  { w: 960, h: 720, label: '960×720' },
  { w: 1280, h: 960, label: '1280×960' },
  { w: 1600, h: 1200, label: '1600×1200' },
  { w: 2048, h: 1536, label: '2048×1536' },
  { w: 2560, h: 1920, label: '2560×1920' },
];

const CELL_COLORS = ['', '#ffcf3f', '#ff5d73', '#5aa9ff', '#2ee6a8', '#ff8b3f', '#9be84d', '#c07aff', '#e9ecff'];
const ARROW_COLORS = ['', '#ffcf3f', '#ff6b6b', '#5aa9ff', '#2ee6a8', '#c07aff', '#ff8b3f', '#e9ecff']; // '' — обычный (золотая дорога / коралловый переход)
const CELL_TYPES: { key: CellType; label: string; cls: string }[] = [
  { key: 'start', label: 'Старт', cls: 'border-gold text-gold bg-gold/10' },
  { key: 'task', label: 'Зад.', cls: 'border-gold text-gold bg-gold/10' },
  { key: 'rest', label: 'Отдых', cls: 'border-dim text-dim bg-dim/10' },
  { key: 'bonus', label: 'Бон.', cls: 'border-teal text-teal bg-teal/10' },
  { key: 'trap', label: 'Лов.', cls: 'border-coral text-coral bg-coral/10' },
  { key: 'quiz', label: 'Квиз', cls: 'border-sky text-sky bg-sky/10' },
];
const LOOT_CELL_TYPE: { key: CellType; label: string; cls: string } = { key: 'loot', label: 'Лут.', cls: 'border-[#ff8b3f] text-[#ff8b3f] bg-[#ff8b3f]/10' }; // ЛУТБОКС — только в режиме RUBG

export default function MapEditor() {
  const { maps, tiles, tokens, anims, bossAnims, challenges, setScreen, refresh, toast } = useApp();
  const [map, setMap] = useState<GameMap | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [tileId, setTileId] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [hoverW, setHoverW] = useState<{ x: number; y: number } | null>(null);
  const [nameModal, setNameModal] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [selCell, setSelCell] = useState<number | null>(null);
  const [selStamp, setSelStamp] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<number | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [snap, setSnap] = useState(false);
  const [tokOpen, setTokOpen] = useState(true); // спойлер «Фишки партии» в левой панели
  const [animOpen, setAnimOpen] = useState(false); // спойлер «Анимации» в левой панели
  const [bossOpen, setBossOpen] = useState(false); // спойлер «Боссы» в левой панели
  const [modeDescOpen, setModeDescOpen] = useState(false); // спойлер «Описания режимов» в панели «Режим игры»
  const [layersOpen, setLayersOpen] = useState(true); // спойлер «Слои» в левой панели
  const [activeLayer, setActiveLayer] = useState(0); // слой, на который ставятся НОВЫЕ тайлы (0 — нижний)
  const [placeAnimId, setPlaceAnimId] = useState(''); // вшитая анимация, выбранная для размещения
  const [selAnim, setSelAnim] = useState<string | null>(null); // выбранная размещённая анимация
  const [placeBossId, setPlaceBossId] = useState(''); // вшитый босс, выбранный для размещения
  const [selBoss, setSelBoss] = useState<string | null>(null); // выбранный размещённый босс
  const [selWall, setSelWall] = useState<number | null>(null); // выбранная стена (индекс)
  const [wallsOpen, setWallsOpen] = useState(true); // спойлер «Стены» в левой панели
  const [selPortal, setSelPortal] = useState<number | null>(null); // выбранный портал (индекс)
  const [pickTargetFor, setPickTargetFor] = useState<number | null>(null); // портал, для которого указываем точку перехода (следующий клик по канве = точка)
  const [platesOpen, setPlatesOpen] = useState(false); // спойлер «Плитки и порталы» в левой панели
  const [tilesOpen, setTilesOpen] = useState(false); // спойлер «Карты-плитки» (плиточный режим) в левой панели
  const [selTileId, setSelTileId] = useState<string | null>(null); // активная карта-плитка (схема + её фон)
  const [bgScope, setBgScope] = useState<'plate' | 'all'>('plate'); // куда ложится НОВЫЙ фон: «на эту плитку» (своя локация) или «на всю карту»
  const [extract, setExtract] = useState<{ file: File; src: string; name: string; busy: boolean; bgMode: 'auto' | 'custom'; bg: string; foundBg: string; thr: number; minSize: number; mergeGap: number; keepText: boolean; tiles: TileImg[] } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLInputElement>(null);
  const extRef = useRef<HTMLInputElement>(null);
  const ghostRef = useRef<HTMLImageElement | null>(null);
  const ghostAnimRef = useRef<HTMLImageElement | null>(null); // первый кадр выбранной для размещения анимации (натуральный размер)
  const ghostBossRef = useRef<HTMLImageElement | null>(null); // первый кадр idle выбранного босса
  const viewRef = useRef(view); viewRef.current = view;
  const mapRef = useRef(map); mapRef.current = map;
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const objDragRef = useRef<{ kind: 'cell' | 'stamp' | 'anim' | 'boss' | 'wall' | 'portal'; idx: number; dx: number; dy: number; moved: boolean } | null>(null);
  const wallDragRef = useRef<{ sx: number; sy: number; ex: number; ey: number } | null>(null); // протягивание НОВОЙ стены
  const portalDragRef = useRef<{ sx: number; sy: number; ex: number; ey: number } | null>(null); // протягивание НОВОГО портала
  const resizeRef = useRef<{ kind: 'stamp' | 'anim' | 'boss'; idx: number } | null>(null); // ресайз тайла/анимации/босса за уголок
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const lastPlaceRef = useRef<{ x: number; y: number } | null>(null);
  const lastCellSize = useRef({ w: CELL, h: CELL }); // размер новых ячеек (запоминается при изменении)
  const lastEraseSfxRef = useRef(0);
  const dirtyRef = useRef(false);
  const toolRef = useRef(tool); toolRef.current = tool;
  const snapRef = useRef(snap); snapRef.current = snap;
  const activeLayerRef = useRef(activeLayer); activeLayerRef.current = activeLayer; // для placeStamp (читается из замыканий)
  /* удаление с клавиатуры (Delete/Backspace), подчиняющееся режиму из Опций */
  const keyDel = useKeyDelete();

  const tileset: TileImg[] = map?.tileset ?? [];
  const tileImgById = useMemo(() => new Map(tileset.map((t) => [t.id, t])), [tileset]);
  const legacyTileById = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);

  /* призрак тайла под курсором — картинка в кэше, рисуется полупрозрачной */
  useEffect(() => {
    const t = (map?.tileset ?? []).find((x) => x.id === tileId);
    if (!t) { ghostRef.current = null; return; }
    const img = new Image();
    img.onload = () => { ghostRef.current = img; };
    img.src = t.dataUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileId, map?.tileset]);

  /* первый кадр выбранной для размещения анимации — для натурального размера экземпляра */
  useEffect(() => {
    const e = (map?.animLib ?? []).find((x) => x.id === placeAnimId);
    if (!e || !e.clip.frames.length) { ghostAnimRef.current = null; return; }
    const img = new Image();
    img.onload = () => { ghostAnimRef.current = img; };
    img.src = e.clip.frames[0];
  }, [placeAnimId, map?.animLib]);

  /* первый кадр idle выбранного для размещения босса */
  useEffect(() => {
    const e = (map?.bossLib ?? []).find((x) => x.id === placeBossId);
    if (!e || !e.idle.frames.length) { ghostBossRef.current = null; return; }
    const img = new Image();
    img.onload = () => { ghostBossRef.current = img; };
    img.src = e.idle.frames[0];
  }, [placeBossId, map?.bossLib]);

  /* ---------- точка в мировых координатах ---------- */
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: v.x + (e.clientX - r.left - r.width / 2) / v.zoom,
      y: v.y + (e.clientY - r.top - r.height / 2) / v.zoom,
    };
  };
  const snapPt = (x: number, y: number) => {
    if (!snapRef.current) return { x, y };
    return { x: Math.round(x / 16) * 16, y: Math.round(y / 16) * 16 };
  };

  /* ---------- правки карты (без глубокого клонирования — карта может весить МБ) ---------- */
  const updMap = (patch: Partial<GameMap>) => setMap((m) => (m ? { ...m, ...patch } : m));

  /* ---------- фишки партии: отмечаем до 12 фишек из библиотеки — они вшиваются в карту
     и уезжают всем игрокам; после жеребьёвки каждый выберет себе одну (одинаковые нельзя).
     АНИМИРОВАННЫЕ фишки вшиваются вместе со своими клипами и размером ---------- */
  const toggleMapToken = (t: TokenDef) => {
    if (!map) return;
    const cur = map.mapTokens ?? [];
    if (cur.some((x) => x.id === t.id)) {
      updMap({ mapTokens: cur.filter((x) => x.id !== t.id) });
      sfx.click();
    } else {
      if (cur.length >= 12) { toast('Максимум 12 фишек на карту — снимите галочку с другой', 'err'); sfx.fail(); return; }
      updMap({ mapTokens: [...cur, { id: t.id, name: t.name, dataUrl: t.dataUrl, createdAt: t.createdAt, ...(t.anim ? { anim: JSON.parse(JSON.stringify(t.anim)) } : {}), ...(t.size !== undefined ? { size: t.size } : {}) }] });
      sfx.coin();
    }
    dirtyRef.current = true;
  };

  /* ---------- анимации карты: вшиваем анимацию из библиотеки автора (уедет всем игрокам),
     после — размещаем экземпляры на поле инструментом «Анимация» ---------- */
  const toggleMapAnim = (a: AnimDef) => {
    if (!map) return;
    const lib = map.animLib ?? [];
    if (lib.some((x) => x.id === a.id)) {
      // убираем из карты вместе с экземплярами
      updMap({ animLib: lib.filter((x) => x.id !== a.id), anims: (map.anims ?? []).filter((pa) => pa.aid !== a.id) });
      if (placeAnimId === a.id) setPlaceAnimId('');
      sfx.click();
    } else {
      updMap({ animLib: [...lib, { id: a.id, name: a.name, clip: JSON.parse(JSON.stringify(a.clip)), ...(a.snd ? { snd: a.snd } : {}) }] });
      setPlaceAnimId(a.id);
      setTool('anim');
      sfx.coin();
      toast(a.snd ? 'Анимация со звуком вшита в карту — кликните по полю, чтобы разместить (радиус зададите в её панели)' : 'Анимация вшита в карту — кликните по полю, чтобы разместить', 'ok');
    }
    dirtyRef.current = true;
  };
  const updAnim = (idx: number, patch: Partial<PlacedAnim>) =>
    setMap((m) => {
      if (!m || !m.anims || !m.anims[idx]) return m;
      const arr = m.anims.slice();
      arr[idx] = { ...arr[idx], ...patch };
      return { ...m, anims: arr };
    });

  /* ---------- боссы карты: вшиваем босса из библиотеки автора (уедет всем игрокам),
     после — размещаем экземпляры на ячейках инструментом «Босс» ---------- */
  const toggleMapBoss = (b: BossAnimDef) => {
    if (!map) return;
    const lib = map.bossLib ?? [];
    if (lib.some((x) => x.id === b.id)) {
      updMap({ bossLib: lib.filter((x) => x.id !== b.id), bosses: (map.bosses ?? []).filter((pb) => pb.bid !== b.id) });
      if (placeBossId === b.id) setPlaceBossId('');
      sfx.click();
    } else {
      /* вшиваем СНИМОК босса (все клипы + звуки, включая клип гибели) — уедет всем игрокам;
         при правке босса позже TokenEditor обновит вшитые копии (syncBossToMaps) */
      updMap({ bossLib: [...lib, bossLibEntryOf(b)] });
      setPlaceBossId(b.id);
      setTool('boss');
      sfx.coin();
      toast('Босс вшит в карту — кликните по ячейке, чтобы поставить его (радиус зададите в его панели)', 'ok');
    }
    dirtyRef.current = true;
  };
  const updBoss = (idx: number, patch: Partial<PlacedBoss>) =>
    setMap((m) => {
      if (!m || !m.bosses || !m.bosses[idx]) return m;
      const arr = m.bosses.slice();
      arr[idx] = { ...arr[idx], ...patch };
      return { ...m, bosses: arr };
    });
  const removeBossAt = (bid: string) => {
    const m = mapRef.current;
    const idx = m ? (m.bosses ?? []).findIndex((b) => b.id === bid) : -1;
    if (m && idx >= 0) {
      const snap = m.bosses![idx];
      rememberDeleted({
        label: `босса «${(m.bossLib ?? []).find((x) => x.id === snap.bid)?.name ?? 'с карты'}»`,
        restore: async () => {
          setMap((mm) => {
            if (!mm || mm.id !== m.id) return mm;
            const arr = (mm.bosses ?? []).slice();
            arr.splice(Math.min(idx, arr.length), 0, snap);
            return { ...mm, bosses: arr };
          });
          const cur = await idbGet<GameMap>('maps', m.id);
          if (cur) {
            const arr = (cur.bosses ?? []).slice();
            arr.splice(Math.min(idx, arr.length), 0, snap);
            await idbPut('maps', m.id, { ...cur, bosses: arr, updatedAt: Date.now() });
            await useApp.getState().refresh();
          }
        },
      });
    }
    setMap((mm) => (mm ? { ...mm, bosses: (mm.bosses ?? []).filter((b) => b.id !== bid) } : mm));
    setSelBoss(null);
    dirtyRef.current = true;
    sfx.fail();
  };
  const removeAnim = (aid: string) => {
    const m = mapRef.current;
    const idx = m ? (m.anims ?? []).findIndex((a) => a.id === aid) : -1;
    if (m && idx >= 0) {
      const snap = m.anims![idx];
      rememberDeleted({
        label: `анимацию «${(m.animLib ?? []).find((x) => x.id === snap.aid)?.name ?? 'с карты'}»`,
        restore: async () => {
          setMap((mm) => {
            if (!mm || mm.id !== m.id) return mm;
            const arr = (mm.anims ?? []).slice();
            arr.splice(Math.min(idx, arr.length), 0, snap);
            return { ...mm, anims: arr };
          });
          const cur = await idbGet<GameMap>('maps', m.id);
          if (cur) {
            const arr = (cur.anims ?? []).slice();
            arr.splice(Math.min(idx, arr.length), 0, snap);
            await idbPut('maps', m.id, { ...cur, anims: arr, updatedAt: Date.now() });
            await useApp.getState().refresh();
          }
        },
      });
    }
    setMap((mm) => (mm ? { ...mm, anims: (mm.anims ?? []).filter((a) => a.id !== aid) } : mm));
    setSelAnim(null);
    dirtyRef.current = true;
    sfx.fail();
  };
  const updCell = (idx: number, patch: Partial<CellDef>) =>
    setMap((m) => {
      if (!m || !m.cells[idx]) return m;
      const cells = m.cells.slice();
      cells[idx] = { ...cells[idx], ...patch };
      // номера — по порядку создания, стрелки/метки на них не влияют — перенумерация не нужна
      return { ...m, cells } as GameMap;
    });

  /* ---------- НЕВИДИМЫЕ СТЕНЫ (только JOURNEY): зоны «куда фишке нельзя» ----------
     Работают ТОЛЬКО в режиме journey — при создании карты редактор проверит режим.
     Стена — прямоугольник в px поля (x,y — левый верх). В игре НЕ рисуется. */
  const updWall = (idx: number, patch: Partial<WallRect>) =>
    setMap((m) => {
      if (!m || !m.walls || !m.walls[idx]) return m;
      const arr = m.walls.slice();
      arr[idx] = { ...arr[idx], ...patch };
      return { ...m, walls: arr };
    });
  const wallAtPoint = (m: GameMap, wx: number, wy: number): number => {
    const ws = m.walls ?? [];
    for (let i = ws.length - 1; i >= 0; i--) {
      const w = ws[i];
      if (wx >= w.x && wx < w.x + w.w && wy >= w.y && wy < w.y + w.h) return i;
    }
    return -1;
  };
  const removeWall = (idx: number) => {
    const m = mapRef.current;
    if (m && m.walls?.[idx]) {
      const snap = m.walls[idx];
      rememberDeleted({
        label: 'стену с карты',
        restore: async () => {
          setMap((mm) => {
            if (!mm || mm.id !== m.id) return mm;
            const arr = (mm.walls ?? []).slice();
            arr.splice(Math.min(idx, arr.length), 0, snap);
            return { ...mm, walls: arr };
          });
          const cur = await idbGet<GameMap>('maps', m.id);
          if (cur) {
            const arr = (cur.walls ?? []).slice();
            arr.splice(Math.min(idx, arr.length), 0, snap);
            await idbPut('maps', m.id, { ...cur, walls: arr, updatedAt: Date.now() });
            await useApp.getState().refresh();
          }
        },
      });
    }
    setMap((mm) => (mm ? { ...mm, walls: (mm.walls ?? []).filter((_, i) => i !== idx) } : mm));
    setSelWall(null);
    dirtyRef.current = true;
    sfx.fail();
  };
  const removeAllWalls = () => {
    const m = mapRef.current;
    const cnt = m?.walls?.length ?? 0;
    if (!cnt) return;
    const snap = m!.walls!;
    rememberDeleted({
      label: `все стены (${cnt})`,
      restore: async () => {
        setMap((mm) => (mm && mm.id === m!.id ? { ...mm, walls: snap.slice() } : mm));
        const cur = await idbGet<GameMap>('maps', m!.id);
        if (cur) {
          await idbPut('maps', m!.id, { ...cur, walls: snap.slice(), updatedAt: Date.now() });
          await useApp.getState().refresh();
        }
      },
    });
    setMap((mm) => (mm ? { ...mm, walls: [] } : mm));
    setSelWall(null);
    dirtyRef.current = true;
    sfx.fail();
    toast(`Удалены все стены (${cnt}) — вернуть можно кнопкой «Вернуть»`, 'err');
  };

  /* ---------- ПОРТАЛЫ: зоны-телепорты между плитками ----------
     Зона входа + точка перехода (tx,ty) в px ВСЕГО поля. В JOURNEY фишка, войдя
     в зону, мгновенно переносится в точку. Однонаправленные: обратный — второй портал. */
  const updPortal = (idx: number, patch: Partial<PortalZone>) =>
    setMap((m) => {
      if (!m || !m.portals || !m.portals[idx]) return m;
      const arr = m.portals.slice();
      arr[idx] = { ...arr[idx], ...patch };
      return { ...m, portals: arr };
    });
  const portalAtPoint = (m: GameMap, wx: number, wy: number): number => {
    const ps = m.portals ?? [];
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      if (wx >= p.x && wx < p.x + p.w && wy >= p.y && wy < p.y + p.h) return i;
    }
    return -1;
  };
  const removePortal = (idx: number) => {
    const m = mapRef.current;
    if (m && m.portals?.[idx]) {
      const snap = m.portals[idx];
      rememberDeleted({
        label: 'портал с карты',
        restore: async () => {
          setMap((mm) => {
            if (!mm || mm.id !== m.id) return mm;
            const arr = (mm.portals ?? []).slice();
            arr.splice(Math.min(idx, arr.length), 0, snap);
            return { ...mm, portals: arr };
          });
          const cur = await idbGet<GameMap>('maps', m.id);
          if (cur) {
            const arr = (cur.portals ?? []).slice();
            arr.splice(Math.min(idx, arr.length), 0, snap);
            await idbPut('maps', m.id, { ...cur, portals: arr, updatedAt: Date.now() });
            await useApp.getState().refresh();
          }
        },
      });
    }
    setMap((mm) => (mm ? { ...mm, portals: (mm.portals ?? []).filter((_, i) => i !== idx) } : mm));
    setSelPortal(null);
    setPickTargetFor(null);
    dirtyRef.current = true;
    sfx.fail();
  };
  const removeAllPortals = () => {
    const m = mapRef.current;
    const cnt = m?.portals?.length ?? 0;
    if (!cnt) return;
    const snap = m!.portals!;
    rememberDeleted({
      label: `все порталы (${cnt})`,
      restore: async () => {
        setMap((mm) => (mm && mm.id === m!.id ? { ...mm, portals: snap.slice() } : mm));
        const cur = await idbGet<GameMap>('maps', m!.id);
        if (cur) {
          await idbPut('maps', m!.id, { ...cur, portals: snap.slice(), updatedAt: Date.now() });
          await useApp.getState().refresh();
        }
      },
    });
    setMap((mm) => (mm ? { ...mm, portals: [] } : mm));
    setSelPortal(null);
    setPickTargetFor(null);
    dirtyRef.current = true;
    sfx.fail();
    toast(`Удалены все порталы (${cnt}) — вернуть можно кнопкой «Вернуть»`, 'err');
  };

  /* ---------- ПЛИТКИ: разбивка поля на страницы одинакового размера ----------
     Поле единое (одно большое), разбивка — удобство редактора: навигатор плиток,
     рамки на канве. Соседние плитки стыкуются краями (переход ходьбой), любые — порталами. */
  const PS = map?.plateSize ?? 0;
  const platesX = map && PS ? Math.max(1, Math.ceil(mapSize(map).w / PS)) : 1;
  const platesY = map && PS ? Math.max(1, Math.ceil(mapSize(map).h / PS)) : 1;
  const plateCountMax = PS ? Math.floor(MAX_FIELD / PS) : 8;
  const applyPlates = (ps: number, nx: number, ny: number) => {
    const m = mapRef.current;
    if (!m) return;
    const nw = Math.min(MAX_FIELD, nx * ps);
    const nh = Math.min(MAX_FIELD, ny * ps);
    updMap({ plateSize: ps, mw: nw, mh: nh } as Partial<GameMap>);
    dirtyRef.current = true;
    // объекты, выехавшие за край при уменьшении поля
    const mm = { ...m, plateSize: ps, mw: nw, mh: nh } as GameMap;
    const out = mm.cells.filter((c, ci) => { const cc = cellCenter(mm, ci); return cc.x > nw || cc.y > nh; }).length
      + (mm.stamps ?? []).filter((s) => s.x > nw || s.y > nh).length
      + (mm.portals ?? []).filter((p) => p.x > nw || p.y > nh).length;
    if (out > 0) toast(`Внимание: ${out} объектов оказались за краем поля — приблизьте и передвиньте их`, 'info');
  };
  const enablePlates = () => {
    const m = mapRef.current;
    if (!m) return;
    const sz = mapSize(m);
    // сторона плитки — ближайшая из стандартных к нынешней большей стороне поля
    const ps = PLATE_SIZES.reduce((a, b) => (Math.abs(b - Math.max(sz.w, sz.h)) < Math.abs(a - Math.max(sz.w, sz.h)) ? b : a), PLATE_SIZES[0]);
    const nx = Math.max(1, Math.ceil(sz.w / ps));
    const ny = Math.max(1, Math.ceil(sz.h / ps));
    applyPlates(ps, nx, ny);
    setPlatesOpen(true);
    sfx.coin();
    toast(`Поле разбито на плитки ${ps} px (${nx}×${ny}). Соседние плитки стыкуются краями, любые связывайте порталами`, 'ok');
  };
  const disablePlates = () => {
    updMap({ plateSize: undefined } as Partial<GameMap>);
    dirtyRef.current = true;
    sfx.fail();
    toast(plateBgCount > 0
      ? `Разбивка на плитки убрана — карта снова одно поле. Свои фоны у ${plateBgCount} плитки(ок) спрятаны и вернутся, когда снова включите разбивку`
      : 'Разбивка на плитки убрана — карта снова одно поле', 'info');
  };
  const jumpToPlate = (col: number, row: number) => {
    const cv = canvasRef.current;
    if (!cv || !PS) return;
    const fit = Math.min(cv.clientWidth / (PS + 80), cv.clientHeight / (PS + 80)); // вся плитка в кадре
    const z = Math.max(viewRef.current.zoom, Math.min(2, fit));
    setView({ x: (col + 0.5) * PS, y: (row + 0.5) * PS, zoom: z });
    sfx.hover();
  };
  const curPlateIdx = PS && map ? Math.min(platesX * platesY - 1, Math.max(0, Math.floor(view.x / PS) + Math.floor(view.y / PS) * platesX)) : -1;
  const plateNumOf = (wx: number, wy: number) => (PS ? Math.floor(wx / PS) + Math.floor(wy / PS) * platesX + 1 : 1); // «Плитка N» по точке поля

  /* ---------- ПЛИТОЧНЫЙ РЕЖИМ КАРТ: несколько отдельных карт-локаций ----------
     Каждая карта-плитка — ОТДЕЛЬНАЯ карта фиксированного размера (как хотел автор):
     в редакторе она выбирается кликом по схеме (камера прыгает на неё), в ИГРЕ фишка
     зажата в пределах СВОЕЙ карты, а на другие попадает ТОЛЬКО через портал
     (соседние они в схеме или нет — неважно). Бесконечное увеличение поля
     (без tileGrid) продолжает работать как раньше. */
  const TG: TileGrid | null = map?.tileGrid ?? null;
  const activeTile = TG ? (TG.tiles.find((t) => t.id === selTileId) ?? TG.tiles[0] ?? null) : null;
  const tileBgCount = map?.tileBgs ? Object.keys(map.tileBgs).length : 0;

  const updTileGrid = (tg: TileGrid | undefined, extra?: Partial<GameMap>) => {
    updMap({ tileGrid: tg, tileBgs: tg ? map?.tileBgs : undefined, ...extra } as Partial<GameMap>);
    dirtyRef.current = true;
  };

  /** Поля → сетка плиток: всё нынешнее содержимое становится ПЕРВОЙ картой-плиткой. */
  const enableTileMode = () => {
    const m = mapRef.current;
    if (!m) return;
    const sz = mapSize(m);
    const tg: TileGrid = { w: sz.w, h: sz.h, tiles: [{ id: uid('mt'), col: 0, row: 0 }] };
    updTileGrid(tg);
    setSelTileId(tg.tiles[0].id);
    setTilesOpen(true);
    sfx.coin();
    toast(`Плиточный режим включён: всё поле стало КАРТОЙ №1 (${sz.w}×${sz.h}). Добавляйте новые карты-плитки кнопкой ниже — между ними ставьте порталы`, 'ok');
  };

  /** Обратно к обычному полю: содержимое остаётся на месте (плитки не двигались). */
  const disableTileMode = () => {
    const n = map?.tileGrid?.tiles.length ?? 0;
    updTileGrid(undefined);
    setSelTileId(null);
    sfx.fail();
    toast(n > 1
      ? `Плиточный режим выключен — карты-плитки остались на поле подряд. Вернуть: включите режим снова (плитка №1 вернётся по размеру поля)`
      : 'Плиточный режим выключен — снова одно обычное поле', 'info');
  };

  /** Размер КАЖДОЙ карты-плитки (все одинаковые) + поле под них. */
  const resizeTileGrid = (axis: 'w' | 'h', v: number) => {
    const m = mapRef.current;
    if (!m?.tileGrid) return;
    const tg = m.tileGrid;
    const g = { ...tg, [axis]: Math.max(640, Math.min(MAX_FIELD, v)) };
    const maxCol = Math.max(0, ...g.tiles.map((t) => t.col));
    const maxRow = Math.max(0, ...g.tiles.map((t) => t.row));
    updTileGrid(g, { mw: (maxCol + 1) * g.w, mh: (maxRow + 1) * g.h });
  };

  /** Новая карта-плитка: свободный слот схемы рядом с активной (право → лево → низ → верх). */
  const addMapTile = () => {
    const m = mapRef.current;
    if (!m?.tileGrid) return;
    const tg = m.tileGrid;
    if (tg.tiles.length >= 24) { toast('Плиток максимум 24 — хватит на большой мир', 'err'); return; }
    const anchor = activeTile ?? tg.tiles[0];
    const taken = new Set(tg.tiles.map((t) => `${t.col},${t.row}`));
    let spot: { col: number; row: number } | null = null;
    const around = anchor
      ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
      : [[0, 0]];
    for (const [dc, dr] of around) {
      const c = (anchor?.col ?? 0) + dc, r = (anchor?.row ?? 0) + dr;
      if (!taken.has(`${c},${r}`)) { spot = { col: c, row: r }; break; }
    }
    if (!spot) {
      // вокруг всё занято — ищем любой свободный слот в границах схемы
      const maxCol = Math.max(0, ...tg.tiles.map((t) => t.col)) + 1;
      const maxRow = Math.max(0, ...tg.tiles.map((t) => t.row)) + 1;
      outer: for (let r = 0; r <= maxRow; r++) for (let c = 0; c <= maxCol; c++) {
        if (!taken.has(`${c},${r}`)) { spot = { col: c, row: r }; break outer; }
      }
    }
    if (!spot) return;
    const nt = { id: uid('mt'), col: spot.col, row: spot.row };
    const g = { ...tg, tiles: [...tg.tiles, nt] };
    updTileGrid(g, { mw: Math.max(m.mw ?? 0, (spot.col + 1) * g.w), mh: Math.max(m.mh ?? 0, (spot.row + 1) * g.h) });
    setSelTileId(nt.id);
    jumpToTile(nt);
    sfx.coin();
    toast(`Добавлена карта-плитка №${g.tiles.length} — камера перешла на неё. Рисуйте новую локацию; связывайте карты порталами`, 'ok');
  };

  /** Удалить карту-плитку вместе с её содержимым (ячейки, штампы, стены, порталы, анимации, боссы). */
  const removeMapTile = (id: string) => {
    const m = mapRef.current;
    if (!m?.tileGrid || m.tileGrid.tiles.length <= 1) { toast('Последнюю карту-плитку удалить нельзя — выключите плиточный режим', 'err'); return; }
    const tg = m.tileGrid;
    const victim = tg.tiles.find((t) => t.id === id);
    if (!victim) return;
    const r = tileRectOf(tg, victim);
    const inRect = (x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    // снимок для «Вернуть» (Ctrl+Z)
    const snap = { map: JSON.parse(JSON.stringify(m)) as GameMap, removedTile: victim };
    rememberDeleted({
      label: `карту-плитку №${tg.tiles.findIndex((t) => t.id === id) + 1}`,
      restore: async () => {
        setMap(snap.map);
        const cur = await idbGet<GameMap>('maps', snap.map.id);
        if (cur) { await idbPut('maps', snap.map.id, snap.map); await useApp.getState().refresh(); }
      },
    });
    const cells = m.cells.filter((c, ci) => { const cc = cellCenter(m, ci); return !inRect(cc.x, cc.y); });
    const stamps = (m.stamps ?? []).filter((s) => !inRect(s.x, s.y));
    const walls = (m.walls ?? []).filter((w) => !inRect(w.x + w.w / 2, w.y + w.h / 2));
    const portals = (m.portals ?? []).filter((p) => !inRect(p.x + p.w / 2, p.y + p.h / 2) && !(p.tx !== undefined && p.ty !== undefined && inRect(p.tx, p.ty)));
    const anims = (m.anims ?? []).filter((a) => !inRect(a.x, a.y));
    const bosses = (m.bosses ?? []).filter((b) => !inRect(b.x, b.y));
    const tileBgs = { ...(m.tileBgs ?? {}) };
    delete tileBgs[id];
    const tiles = tg.tiles.filter((t) => t.id !== id);
    const maxCol = Math.max(0, ...tiles.map((t) => t.col));
    const maxRow = Math.max(0, ...tiles.map((t) => t.row));
    const mw = (maxCol + 1) * tg.w, mh = (maxRow + 1) * tg.h;
    // стрелки-переходы на удалённые ячейки — чистим: пересчёт индексов оставшихся
    const keptIdx = new Set<number>();
    for (let i = 0; i < m.cells.length; i++) {
      const cc = cellCenter(m, i);
      if (!inRect(cc.x, cc.y)) keptIdx.add(i);
    }
    const remap = new Map<number, number>();
    { let k = 0; for (let i = 0; i < m.cells.length; i++) if (keptIdx.has(i)) remap.set(i, k++); }
    const cleaned = cells.map((c) => {
      const next: CellDef = { ...c };
      if (next.next !== null && next.next !== undefined) next.next = remap.get(next.next);
      if (next.hop !== null && next.hop !== undefined) next.hop = remap.get(next.hop);
      return next;
    });
    const upd: Partial<GameMap> = { cells: cleaned, stamps, walls, portals, anims, bosses, tileBgs: Object.keys(tileBgs).length ? tileBgs : undefined, mw, mh };
    updTileGrid({ ...tg, tiles }, upd);
    if (selTileId === id) setSelTileId(tiles[0]?.id ?? null);
    setSelCell(null);
    sfx.fail();
    const lost = m.cells.length - cleaned.length;
    toast(`Карта-плитка удалена вместе с содержимым (ячеек: ${lost}) — вернуть можно кнопкой «Вернуть»`, 'err');
  };

  /** Камера — на эту карту-плитку (вся в кадре), как «переход между картами». */
  const jumpToTile = (t: { id: string; col: number; row: number }) => {
    const cv = canvasRef.current;
    const tg = mapRef.current?.tileGrid;
    if (!cv || !tg) return;
    const fit = Math.min(cv.clientWidth / (tg.w + 80), cv.clientHeight / (tg.h + 80)); // вся плитка в кадре
    const z = Math.max(viewRef.current.zoom, Math.min(2, fit));
    setView({ x: (t.col + 0.5) * tg.w, y: (t.row + 0.5) * tg.h, zoom: z });
    sfx.hover();
  };

  const selectTile = (t: { id: string; col: number; row: number }) => {
    setSelTileId(t.id);
    jumpToTile(t);
  };

  /** Схема плиток: размер клетки — 26px, масштаб по самой длинной стороне сетки. */
  const tgCols = TG ? Math.max(1, ...TG.tiles.map((t) => t.col)) + 1 : 1;
  const tgRows = TG ? Math.max(1, ...TG.tiles.map((t) => t.row)) + 1 : 1;

  /** Свой фон КАРТЫ-ПЛИТКИ (плиточный режим): ключ — id плитки. */
  const setTileBg = (id: string, pb: PlateBg | undefined) => {
    if (!map) return;
    const rest = { ...(map.tileBgs ?? {}) };
    if (pb) rest[id] = pb;
    else delete rest[id];
    updMap({ tileBgs: Object.keys(rest).length ? rest : undefined } as Partial<GameMap>);
  };

  const updStamp = (idx: number, patch: Partial<Stamp>) =>
    setMap((m) => {
      if (!m || !m.stamps || !m.stamps[idx]) return m;
      const stamps = m.stamps.slice();
      stamps[idx] = { ...stamps[idx], ...patch };
      return { ...m, stamps };
    });
  const renumber = () =>
    setMap((m) => {
      if (!m) return m;
      const nm = { ...m, cells: m.cells.slice() } as GameMap;
      renumberByPath(nm);
      return nm;
    });

  const persist = async (mm?: GameMap) => {
    const m = mm ?? mapRef.current;
    if (!m) return;
    m.updatedAt = Date.now();
    await idbPut('maps', m.id, m);
    await refresh();
  };
  const persistIfDirty = async () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    await persist();
  };

  /* ---------- открытие/создание карты ---------- */
  const openMap = (m: GameMap) => {
    const copy = migrateMap(JSON.parse(JSON.stringify(m)) as GameMap, tiles);
    setMap(copy);
    setSelCell(null);
    setSelStamp(null);
    setSelAnim(null);
    setPlaceAnimId('');
    setLinkFrom(null);
    setSelWall(null);
    setSelPortal(null);
    setPickTargetFor(null);
    setTool('select');
    setActiveLayer(Math.max(0, (copy.tileLayers ?? 2) - 1)); // новые тайлы — на верхний слой (чем моложе, тем выше)
    requestAnimationFrame(() => {
      const cv = canvasRef.current;
      if (cv) setView(fitView(copy, cv.clientWidth, cv.clientHeight));
    });
    sfx.coin();
  };

  const newMap = () => {
    const m: GameMap = {
      id: uid('map'), name: 'Новая карта', cols: 20, rows: 15,
      mw: 1280, mh: 960,
      tiles: [], cells: [], bonusCards: [], trapCards: [], quizzes: [],
      tileset: [], tileGroups: [], stamps: [],
      startMin: 60, startTries: 60,
      ready: false, createdAt: Date.now(), updatedAt: Date.now(),
    };
    openMap(m);
  };

  /* ---------- загрузка тайлов и фона ---------- */
  const addTileFiles = async (files: FileList | null, kind: 'folder' | 'files' = 'files') => {
    if (!files || !map) return;
    // группируем картинки: папка — по имени выбранной папки, файлы — в общую группу
    const byFolder = new Map<string, TileImg[]>();
    let count = 0;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const r = await importImage(f, 512);
      if (!r) continue;
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
      let folder: string;
      if (kind === 'folder' && rel.includes('/')) folder = rel.split('/')[0] || 'Папка';
      else if (kind === 'folder') folder = 'Папка';
      else folder = 'Загруженные файлы';
      const t: TileImg = { id: uid('timg'), name: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 24) || 'тайл', dataUrl: r.url };
      const arr = byFolder.get(folder);
      if (arr) arr.push(t); else byFolder.set(folder, [t]);
      count++;
    }
    if (!count) { toast('Картинок не найдено', 'err'); return; }
    setMap((mm) => {
      if (!mm) return mm;
      const tileset = [...(mm.tileset ?? [])];
      let groups = [...(mm.tileGroups ?? [])];
      for (const [folder, imgs] of byFolder) {
        for (const t of imgs) tileset.push(t);
        const ex = groups.find((g) => g.name === folder && g.kind === kind);
        if (ex) {
          groups = groups.map((g) => (g.id === ex.id ? { ...g, tids: [...g.tids, ...imgs.map((i) => i.id)] } : g));
        } else {
          groups = [...groups, { id: uid('tg'), name: folder, tids: imgs.map((i) => i.id), kind } as TileGroup];
        }
      }
      return { ...mm, tileset, tileGroups: groups };
    });
    if (!tileId) {
      const first = byFolder.values().next().value![0];
      setTileId(first.id);
    }
    sfx.coin();
    toast(`Добавлено тайлов: ${count}`, 'ok');
  };

  /* спойлеры палитры: свернуть/развернуть */
  const toggleGroup = (gid: string) =>
    updMap({ tileGroups: (map?.tileGroups ?? []).map((g) => (g.id === gid ? { ...g, collapsed: !g.collapsed } : g)) });

  /* убрать спойлер из панели (папку на компьютере не трогаем) */
  const delGroup = (g: TileGroup) => {
    if (!map) return;
    const used = (map.stamps ?? []).filter((s) => g.tids.includes(s.tid)).length;
    if (used > 0) {
      const ok = window.confirm(`Тайлы этой группы уже стоят на карте (${used} шт.). Убрать группу вместе с ними с карты?`);
      if (!ok) return;
    }
    const patch = {
      tileset: map.tileset ?? [],
      tileGroups: map.tileGroups ?? [],
      stamps: map.stamps ?? [],
    };
    rememberDeleted({
      label: `папку «${g.name}» (${g.tids.length} тайл.)`,
      restore: async () => {
        setMap((m) => (m && m.id === map.id ? { ...m, ...patch } : m)); // если карта всё ещё открыта
        const cur = await idbGet<GameMap>('maps', map.id);
        if (cur) { await idbPut('maps', map.id, { ...cur, ...patch, updatedAt: Date.now() }); await useApp.getState().refresh(); }
      },
    });
    const tset = new Set(g.tids);
    updMap({
      tileset: (map.tileset ?? []).filter((t) => !tset.has(t.id)),
      tileGroups: (map.tileGroups ?? []).filter((x) => x.id !== g.id),
      stamps: (map.stamps ?? []).filter((s) => !tset.has(s.tid)),
    });
    if (g.tids.includes(tileId)) setTileId('');
    dirtyRef.current = true;
    sfx.fail();
  };

  /* ИЗМЕНЕНИЕ РАЗМЕРА тайла палитры (+/− под тайлом): 1 px по большей стороне,
     с теми же правилами, что у крестика удаления (режим из Опций). Вырезатель
     иногда завышает размер — правится на месте.
     Уже поставленные штампы не двигаются (у них свой размер), новые ставятся по новому. */
  const resizePalTile = async (t: TileImg, dir: 1 | -1) => {
    const nd = await scaleTileImg(t.dataUrl, dir);
    if (nd === t.dataUrl) return;
    setMap((mm) => (mm ? { ...mm, tileset: (mm.tileset ?? []).map((x) => (x.id === t.id ? { ...x, dataUrl: nd } : x)) } : mm));
    dirtyRef.current = true;
    sfx.hover();
  };

  const delTile = (tid: string) => {
    if (!map) return;
    const patch = {
      tileset: map.tileset ?? [],
      tileGroups: map.tileGroups ?? [],
      stamps: map.stamps ?? [],
    };
    rememberDeleted({
      label: `тайл «${(map.tileset ?? []).find((t) => t.id === tid)?.name ?? tid}»`,
      restore: async () => {
        setMap((m) => (m && m.id === map.id ? { ...m, ...patch } : m));
        const cur = await idbGet<GameMap>('maps', map.id);
        if (cur) { await idbPut('maps', map.id, { ...cur, ...patch, updatedAt: Date.now() }); await useApp.getState().refresh(); }
      },
    });
    const stamps = (map.stamps ?? []).filter((s) => s.tid !== tid);
    updMap({
      tileset: (map.tileset ?? []).filter((t) => t.id !== tid),
      tileGroups: (map.tileGroups ?? []).map((g) => ({ ...g, tids: g.tids.filter((x) => x !== tid) })),
      stamps,
    });
    if (tileId === tid) setTileId('');
    sfx.fail();
  };

  /* ФОН: при разбивке на плитки выбор КУДА — «на эту плитку» (своя локация, ключ = номер
     плитки из навигатора) или «на всю карту» (одна картинка на всё поле, как раньше) */
  const setPlateBg = (n: number, pb: PlateBg | undefined) => {
    if (!map) return;
    const rest = { ...(map.plateBgs ?? {}) };
    if (pb) rest[n] = pb;
    else delete rest[n];
    updMap({ plateBgs: Object.keys(rest).length ? rest : undefined } as Partial<GameMap>);
  };
  const setBg = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !map) return;
    const r = await importImage(f, 2000, true);
    if (!r) { toast('Это не картинка', 'err'); return; }
    if (map.tileGrid && bgScope === 'plate') {
      const t = activeTile ?? map.tileGrid.tiles[0];
      if (!t) return;
      setTileBg(t.id, { bg: r.url, bgMode: 'stretch' });
      sfx.coin();
      toast(`Фон загружен на КАРТУ-ПЛИТКУ №${map.tileGrid.tiles.findIndex((x) => x.id === t.id) + 1} — остальные карты не тронуты (другим — свой фон через схему плиток)`, 'ok');
    } else if (map.plateSize && bgScope === 'plate') {
      const n = curPlateIdx + 1; // плитка, на которую сейчас смотрит камера
      setPlateBg(n, { bg: r.url, bgMode: 'stretch' });
      sfx.coin();
      toast(`Фон загружен на ПЛИТКУ ${n} — остальные плитки не тронуты (другим плиткам — свой фон через навигатор)`, 'ok');
    } else {
      updMap({ bg: r.url, bgMode: 'stretch' });
      sfx.coin();
      toast('Общий фон карты загружен (на всё поле)', 'ok');
    }
  };

  /* ---------- ЭКСТРАКТОР: нарезка тайлов из картинки с однотонным фоном ---------- */
  const exInfoRef = useRef<{ W: number; H: number; data: Uint8ClampedArray } | null>(null); // пиксели превью для пипетки
  const exRunRef = useRef(0);
  const exTimerRef = useRef<number | null>(null);

  const runExtract = async (base: { file: File; src: string; bgMode: 'auto' | 'custom'; bg: string; thr: number; minSize: number; mergeGap: number; keepText: boolean; name: string }, patch: Partial<typeof base>) => {
    const next = { ...base, ...patch };
    setExtract((ex) => (ex && ex.src === next.src ? { ...ex, ...next, busy: true } : ex));
    const run = ++exRunRef.current;
    try {
      const r = await extractTilesFromImage(next.file, { bgMode: next.bgMode, bg: next.bg, thr: next.thr, minSize: next.minSize, mergeGap: next.mergeGap, keepText: next.keepText }, exInfoRef);
      if (exRunRef.current !== run) return;
      setExtract((ex) => (ex && ex.src === next.src ? { ...ex, tiles: r.tiles, foundBg: r.bg, busy: false } : ex));
      if (!r.tiles.length) toast('Ничего не нашлось: снизьте мин. размер, поменяйте фон или допуск', 'err');
      else sfx.coin();
    } catch {
      if (exRunRef.current !== run) return;
      setExtract((ex) => (ex && ex.src === next.src ? { ...ex, busy: false } : ex));
      toast('Не удалось обработать картинку', 'err');
    }
  };

  /* смена параметра: мгновенно показываем цифру, пересчёт — с небольшой задержкой */
  const tuneExtract = (patch: { bgMode?: 'auto' | 'custom'; bg?: string; thr?: number; minSize?: number; mergeGap?: number; keepText?: boolean }) => {
    if (!extract) return;
    const base = { ...extract, ...patch };
    setExtract(base);
    if (exTimerRef.current) window.clearTimeout(exTimerRef.current);
    exTimerRef.current = window.setTimeout(() => void runExtract(base, {}), 180);
  };

  /* ПИПЕТКА: клик по превью — взять цвет фона из этой точки */
  const pipetteBg = (e: { clientX: number; clientY: number; currentTarget: HTMLImageElement }) => {
    if (!extract) return;
    const im = e.currentTarget;
    const info = exInfoRef.current;
    if (!info || !im.naturalWidth) return;
    const r = im.getBoundingClientRect();
    const sc0 = Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight); // object-contain: учитываем поля
    const dw = im.naturalWidth * sc0, dh = im.naturalHeight * sc0;
    const ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
    const fx = (e.clientX - r.left - ox) / dw;
    const fy = (e.clientY - r.top - oy) / dh;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return;
    const x = Math.min(info.W - 1, Math.round(fx * info.W));
    const y = Math.min(info.H - 1, Math.round(fy * info.H));
    const i = (y * info.W + x) * 4;
    const hex = (v: number) => v.toString(16).padStart(2, '0');
    tuneExtract({ bgMode: 'custom', bg: `#${hex(info.data[i])}${hex(info.data[i + 1])}${hex(info.data[i + 2])}` });
    sfx.hover();
  };

  const openExtract = async (f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Это не картинка', 'err'); return; }
    const name = f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 20) || 'Вырезанное';
    const st = { file: f, src: URL.createObjectURL(f), name, busy: true, bgMode: 'auto' as const, bg: '#000000', foundBg: '', thr: 25, minSize: 6, mergeGap: 1, keepText: false, tiles: [] as TileImg[] };
    setExtract(st);
    sfx.hover();
    await runExtract(st, {});
  };

  const closeExtract = () => {
    if (exTimerRef.current) { window.clearTimeout(exTimerRef.current); exTimerRef.current = null; }
    exRunRef.current++;
    if (extract) URL.revokeObjectURL(extract.src);
    setExtract(null);
  };

  const addExtractToPalette = () => {
    if (!map || !extract || !extract.tiles.length) return;
    const name = extract.name.trim() || 'Вырезанное';
    setMap((mm) => {
      if (!mm) return mm;
      const groups = [...(mm.tileGroups ?? [])];
      const ex = groups.find((g) => g.name === name && g.kind === 'extract');
      const newIds = extract.tiles.map((t) => t.id);
      const tileGroups = ex
        ? groups.map((g) => (g.id === ex.id ? { ...g, tids: [...g.tids, ...newIds] } : g))
        : [...groups, { id: uid('tg'), name, tids: newIds, kind: 'extract' } as TileGroup];
      return { ...mm, tileset: [...(mm.tileset ?? []), ...extract.tiles], tileGroups };
    });
    if (!tileId) setTileId(extract.tiles[0].id);
    URL.revokeObjectURL(extract.src);
    setExtract(null);
    dirtyRef.current = true;
    sfx.coin();
    toast('Вырезанные тайлы добавлены в палитру', 'ok');
  };

  /* ---------- штампы ---------- */
  const placeStamp = (wx: number, wy: number) => {
    const m = mapRef.current;
    const t = tileImgById.get(tileId);
    if (!m || !t) return;
    const img = new Image();
    img.onload = () => {
      const natW = img.width || 64, natH = img.height || 64;
      const maxSide = Math.max(natW, natH);
      const k = maxSide < 64 ? 64 / maxSide : maxSide > 128 ? 128 / maxSide : 1;
      const p = snapPt(wx, wy);
      const st: Stamp = { id: uid('st'), tid: tileId, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(natW * k), h: Math.round(natH * k), rot: 0, ...(activeLayerRef.current > 0 ? { layer: activeLayerRef.current } : {}) };
      setMap((mm) => (mm ? { ...mm, stamps: [...(mm.stamps ?? []), st] } : mm));
      setSelStamp(st.id);
      setSelCell(null);
      dirtyRef.current = true;
      sfx.step();
    };
    img.src = t.dataUrl;
  };

  /* ---------- ячейки ---------- */
  const addCellAt = (wx: number, wy: number) => {
    const m = mapRef.current;
    if (!m) return;
    const p = snapPt(wx, wy);
    const c: CellDef = {
      n: m.cells.length + 1,
      x: 0, y: 0,
      cx: Math.round(p.x), cy: Math.round(p.y),
      cw: lastCellSize.current.w, ch: lastCellSize.current.h,
      type: 'task', task: null,
    };
    setMap((mm) => {
      if (!mm) return mm;
      const nm = { ...mm, cells: [...mm.cells, c] } as GameMap;
      renumberByPath(nm);
      return nm;
    });
    setSelCell(m.cells.length);
    setSelStamp(null);
    dirtyRef.current = true;
    sfx.step();
  };

  /* запомнить удаляемый штамп — Ctrl+Z вернёт его на то же место.
     Ластик и клавиша Delete работают как раньше (сразу), но теперь отменяются */
  const forgetStamp = (idx: number) => {
    const m = mapRef.current;
    const st = m?.stamps?.[idx];
    if (!m || !st) return;
    const label = `тайл «${tileImgById.get(st.tid)?.name ?? 'с карты'}» с карты`;
    rememberDeleted({
      label,
      restore: async () => {
        setMap((mm) => {
          if (!mm || mm.id !== m.id) return mm;
          const stamps = (mm.stamps ?? []).slice();
          stamps.splice(Math.min(idx, stamps.length), 0, st);
          return { ...mm, stamps };
        });
        const cur = await idbGet<GameMap>('maps', m.id);
        if (cur) {
          const stamps = (cur.stamps ?? []).slice();
          stamps.splice(Math.min(idx, stamps.length), 0, st);
          await idbPut('maps', m.id, { ...cur, stamps, updatedAt: Date.now() });
          await useApp.getState().refresh();
        }
      },
    });
  };

  /* удалить штамп по индексу: запомнить для Ctrl+Z и убрать (кнопка «Удалить тайл» в панели и клавиша Delete) */
  const deleteStampNow = (idx: number) => {
    const m = mapRef.current;
    const st = m?.stamps?.[idx];
    if (!m || !st) return;
    forgetStamp(idx);
    setMap((mm) => (mm ? { ...mm, stamps: (mm.stamps ?? []).filter((s) => s.id !== st.id) } : mm));
    setSelStamp(null);
    dirtyRef.current = true;
  };

  /* ---------- УДАЛЕНИЕ ТАЙЛОВОГО СЛОЯ (крестик в спойлере «Слои карты») ----------
     Слой уходит ВМЕСТЕ со всеми тайлами на нём; слои выше сдвигаются вниз на один,
     фон и «Ячейки и стрелки» не трогаем. Подчиняется режиму удаления (сразу/окно/
     удержание) — крестик это HoldDeleteButton, и Ctrl+Z возвращает слой и тайлы.
     Минимум остаётся один тайловый слой: на последнем крестик просто не рисуем. */
  const deleteLayerNow = (layerIdx: number) => {
    const m = mapRef.current;
    if (!m) return;
    const before = Math.max(1, m.tileLayers ?? 2);
    if (before <= 1 || layerIdx < 0 || layerIdx >= before) return;
    const removed = (m.stamps ?? [])
      .map((s, idx) => ({ s, idx }))
      .filter((x) => (x.s.layer ?? 0) === layerIdx);
    const selSt = selStamp ? (m.stamps ?? []).find((s) => s.id === selStamp) : null;
    rememberDeleted({
      label: `слой ${layerIdx + 1}${removed.length ? ` (тайлов: ${removed.length})` : ' (пустой)'}`,
      restore: async () => {
        // сдвинутым слоям возвращаем старые номера, удалённые тайлы — на прежние места
        setMap((mm) => {
          if (!mm || mm.id !== m.id) return mm;
          const stamps = (mm.stamps ?? []).map((s) => ((s.layer ?? 0) >= layerIdx ? { ...s, layer: (s.layer ?? 0) + 1 } : s));
          for (const { s, idx } of removed) stamps.splice(Math.min(idx, stamps.length), 0, s);
          return { ...mm, tileLayers: before, stamps };
        });
        const cur = await idbGet<GameMap>('maps', m.id);
        if (cur) {
          const stamps = (cur.stamps ?? []).map((s) => ((s.layer ?? 0) >= layerIdx ? { ...s, layer: (s.layer ?? 0) + 1 } : s));
          for (const { s, idx } of removed) stamps.splice(Math.min(idx, stamps.length), 0, s);
          await idbPut('maps', m.id, { ...cur, tileLayers: before, stamps, updatedAt: Date.now() });
          await useApp.getState().refresh();
        }
        setActiveLayer((a) => Math.max(0, Math.min(a, before - 1)));
      },
    });
    if (selSt && (selSt.layer ?? 0) === layerIdx) setSelStamp(null); // выбранный тайл уходит вместе со слоем
    setMap((mm) => {
      if (!mm) return mm;
      const stamps = (mm.stamps ?? [])
        .filter((s) => (s.layer ?? 0) !== layerIdx)
        .map((s) => ((s.layer ?? 0) > layerIdx ? { ...s, layer: (s.layer ?? 0) - 1 } : s));
      return { ...mm, tileLayers: before - 1, stamps };
    });
    setActiveLayer((a) => Math.max(0, Math.min(a > layerIdx ? a - 1 : a, before - 2)));
    dirtyRef.current = true;
    toast(`Слой ${layerIdx + 1} удалён${removed.length ? ` (тайлов: ${removed.length})` : ''} — Ctrl+Z вернёт`, 'err');
  };

  const deleteCell = (idx: number) => {
    const m = mapRef.current;
    const cell = m?.cells[idx];
    if (m && cell) {
      rememberDeleted({
        label: `ячейку маршрута`,
        restore: async () => {
          setMap((mm) => {
            if (!mm || mm.id !== m.id) return mm;
            const cells = mm.cells.slice();
            cells.splice(Math.min(idx, cells.length), 0, cell);
            return { ...mm, cells } as GameMap;
          });
          const cur = await idbGet<GameMap>('maps', m.id);
          if (cur) {
            const cells = cur.cells.slice();
            cells.splice(Math.min(idx, cells.length), 0, cell);
            await idbPut('maps', m.id, { ...cur, cells, updatedAt: Date.now() });
            await useApp.getState().refresh();
          }
        },
      });
    }
    setMap((mm) => {
      if (!mm || !mm.cells[idx]) return mm;
      const cells = mm.cells.slice();
      cells.splice(idx, 1);
      const nm = { ...mm, cells } as GameMap;
      fixLinksAfterDelete(nm, idx);
      return nm;
    });
    setSelCell(null);
    dirtyRef.current = true;
    sfx.fail();
  };

  const setLink = (from: number, to: number | null) => {
    setMap((mm) => {
      if (!mm || !mm.cells[from]) return mm;
      const cells = mm.cells.slice();
      cells[from] = { ...cells[from], next: to ?? undefined };
      return { ...mm, cells } as GameMap;
    });
    dirtyRef.current = true;
  };

  /* вторая стрелка «переход»: прыжок при остановке на ячейке */
  const setHop = (from: number, to: number | null) => {
    setMap((mm) => {
      if (!mm || !mm.cells[from]) return mm;
      const cells = mm.cells.slice();
      cells[from] = { ...cells[from], hop: to ?? undefined };
      return { ...mm, cells } as GameMap;
    });
    dirtyRef.current = true;
  };

  /* ---------- события холста ---------- */
  const selStampIdx = map ? (map.stamps ?? []).findIndex((s) => s.id === selStamp) : -1;

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const m = mapRef.current;
    if (!m) return;
    downRef.current = { x: e.clientX, y: e.clientY };
    const w = toWorld(e);
    // ресайз тайла/анимации/босса за жёлтый уголок — работает в «Выборе», «Тайле», «Анимации» и «Боссе»
    if ((tool === 'select' || tool === 'tile' || tool === 'anim' || tool === 'boss') && (selStamp || selAnim || selBoss)) {
      if (selStamp) {
        const si = (m.stamps ?? []).findIndex((s) => s.id === selStamp);
        if (si >= 0) {
          const s = m.stamps![si];
          const rot = s.rot % 2 === 1;
          const vw = rot ? s.h : s.w, vh = rot ? s.w : s.h;
          const grab = 11 / viewRef.current.zoom;
          const cs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
          for (const [ox, oy] of cs) {
            if (Math.abs(w.x - (s.x + (ox * vw) / 2)) <= grab && Math.abs(w.y - (s.y + (oy * vh) / 2)) <= grab) {
              resizeRef.current = { kind: 'stamp', idx: si };
              return;
            }
          }
        }
      }
      if (selAnim) {
        const ai = (m.anims ?? []).findIndex((a) => a.id === selAnim);
        if (ai >= 0) {
          const a = m.anims![ai];
          const grab = 11 / viewRef.current.zoom;
          const cs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
          for (const [ox, oy] of cs) {
            if (Math.abs(w.x - (a.x + (ox * a.w) / 2)) <= grab && Math.abs(w.y - (a.y + (oy * a.h) / 2)) <= grab) {
              resizeRef.current = { kind: 'anim', idx: ai };
              return;
            }
          }
        }
      }
      if (selBoss) {
        const bi = (m.bosses ?? []).findIndex((b) => b.id === selBoss);
        if (bi >= 0) {
          const b = m.bosses![bi];
          const grab = 11 / viewRef.current.zoom;
          const cs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
          for (const [ox, oy] of cs) {
            if (Math.abs(w.x - (b.x + (ox * b.w) / 2)) <= grab && Math.abs(w.y - (b.y + (oy * b.h) / 2)) <= grab) {
              resizeRef.current = { kind: 'boss', idx: bi };
              return;
            }
          }
        }
      }
    }
    // средняя/правая кнопка — всегда камера
    if (tool === 'pan' || e.button === 1 || e.button === 2) {
      dragRef.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
      return;
    }
    if (tool === 'select') {
      const bi = bossAtPoint(m, w.x, w.y);
      if (bi >= 0) {
        const pb = (m.bosses ?? [])[bi];
        objDragRef.current = { kind: 'boss', idx: bi, dx: w.x - pb.x, dy: w.y - pb.y, moved: false };
        setSelBoss(pb.id);
        setSelAnim(null);
        setSelCell(null);
        setSelStamp(null);
        sfx.hover();
        return;
      }
      const ai = animAtPoint(m, w.x, w.y);
      if (ai >= 0) {
        const pa = (m.anims ?? [])[ai];
        objDragRef.current = { kind: 'anim', idx: ai, dx: w.x - pa.x, dy: w.y - pa.y, moved: false };
        setSelAnim(pa.id);
        setSelCell(null);
        setSelStamp(null);
        sfx.hover();
        return;
      }
      const ci = cellAtPoint(m, w.x, w.y);
      if (ci >= 0) {
        const c = cellCenter(m, ci);
        objDragRef.current = { kind: 'cell', idx: ci, dx: w.x - c.x, dy: w.y - c.y, moved: false };
        setSelCell(ci);
        setSelStamp(null);
        sfx.hover();
        return;
      }
      const si = stampAtPoint(m, w.x, w.y);
      if (si >= 0) {
        const st = (m.stamps ?? [])[si];
        objDragRef.current = { kind: 'stamp', idx: si, dx: w.x - st.x, dy: w.y - st.y, moved: false };
        setSelStamp(st.id);
        setSelCell(null);
        sfx.hover();
        return;
      }
      setSelCell(null);
      setSelStamp(null);
      setSelAnim(null);
      setSelBoss(null);
      dragRef.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
      return;
    }
    if (tool === 'tile') {
      placeStamp(w.x, w.y);
      lastPlaceRef.current = { x: w.x, y: w.y };
      return;
    }
    if (tool === 'cell') {
      const ci = cellAtPoint(m, w.x, w.y);
      if (ci >= 0) { setSelCell(ci); setSelStamp(null); sfx.hover(); return; }
      addCellAt(w.x, w.y);
      return;
    }
    if (tool === 'link') {
      const ci = cellAtPoint(m, w.x, w.y);
      if (ci < 0) { setLinkFrom(null); return; }
      if (linkFrom === null) {
        setLinkFrom(ci);
        sfx.hover();
      } else if (linkFrom === ci) {
        setLink(ci, null); // та же ячейка — убрать стрелку
        setLinkFrom(null);
        sfx.fail();
      } else {
        setLink(linkFrom, ci);
        setLinkFrom(null);
        sfx.coin();
      }
      return;
    }
    if (tool === 'hop') {
      const ci = cellAtPoint(m, w.x, w.y);
      if (ci < 0) { setLinkFrom(null); return; }
      if (linkFrom === null) {
        setLinkFrom(ci);
        sfx.hover();
      } else if (linkFrom === ci) {
        setHop(ci, null); // та же ячейка — убрать переход
        setLinkFrom(null);
        sfx.fail();
      } else {
        setHop(linkFrom, ci);
        setLinkFrom(null);
        sfx.coin();
        toast('ПЕРЕХОД готов: фишка прыгнет по стрелке, когда ОСТАНОВИТСЯ на исходной ячейке', 'ok');
      }
      return;
    }
    if (tool === 'anim') {
      // клик по уже стоящей анимации — выбрать и тянуть; иначе ставим выбранную в панели
      const ai = animAtPoint(m, w.x, w.y);
      if (ai >= 0) {
        const pa = (m.anims ?? [])[ai];
        objDragRef.current = { kind: 'anim', idx: ai, dx: w.x - pa.x, dy: w.y - pa.y, moved: false };
        setSelAnim(pa.id);
        setSelCell(null);
        setSelStamp(null);
        sfx.hover();
        return;
      }
      if (placeAnimId && (m.animLib ?? []).some((x) => x.id === placeAnimId)) {
        const img = ghostAnimRef.current;
        const natW = img?.width || 64, natH = img?.height || 64;
        const maxSide = Math.max(natW, natH);
        const k = maxSide < 64 ? 64 / maxSide : maxSide > 128 ? 128 / maxSide : 1;
        const p = snapPt(w.x, w.y);
        const withSnd = !!(m.animLib ?? []).find((x) => x.id === placeAnimId)?.snd; // у анимации со звуком — стартовый радиус
        const pa: PlacedAnim = { id: uid('anim'), aid: placeAnimId, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(natW * k), h: Math.round(natH * k), ...(withSnd ? { r: 160 } : {}) };
        setMap((mm) => (mm ? { ...mm, anims: [...(mm.anims ?? []), pa] } : mm));
        setSelAnim(pa.id);
        setSelCell(null);
        setSelStamp(null);
        dirtyRef.current = true;
        sfx.step();
      } else {
        toast('Сначала выберите анимацию в левой панели (спойлер «Анимации»)', 'info');
      }
      return;
    }
    if (tool === 'boss') {
      // клик по уже стоящему боссу — выбрать и тянуть; иначе ставим выбранного в панели
      const bi = bossAtPoint(m, w.x, w.y);
      if (bi >= 0) {
        const pb = (m.bosses ?? [])[bi];
        objDragRef.current = { kind: 'boss', idx: bi, dx: w.x - pb.x, dy: w.y - pb.y, moved: false };
        setSelBoss(pb.id);
        setSelAnim(null);
        setSelCell(null);
        setSelStamp(null);
        sfx.hover();
        return;
      }
      if (placeBossId && (m.bossLib ?? []).some((x) => x.id === placeBossId)) {
        const img = ghostBossRef.current;
        const natW = img?.width || 64, natH = img?.height || 64;
        const maxSide = Math.max(natW, natH);
        const k = maxSide < 64 ? 64 / maxSide : maxSide > 128 ? 128 / maxSide : 1;
        const p = snapPt(w.x, w.y);
        const pb: PlacedBoss = { id: uid('boss'), bid: placeBossId, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(natW * k), h: Math.round(natH * k), r: 160 };
        setMap((mm) => (mm ? { ...mm, bosses: [...(mm.bosses ?? []), pb] } : mm));
        setSelBoss(pb.id);
        setSelAnim(null);
        setSelCell(null);
        setSelStamp(null);
        dirtyRef.current = true;
        sfx.step();
      } else {
        toast('Сначала вшейте босса в карту и выберите его в левой панели (спойлер «Боссы»)', 'info');
      }
      return;
    }
    if (tool === 'erase') {
      const si = stampAtPoint(m, w.x, w.y);
      if (si >= 0) {
        forgetStamp(si);
        setMap((mm) => (mm ? { ...mm, stamps: (mm.stamps ?? []).filter((_, i) => i !== si) } : mm));
        if (selStamp === (mapRef.current?.stamps ?? [])[si]?.id) setSelStamp(null);
        dirtyRef.current = true;
        lastEraseSfxRef.current = Date.now();
        sfx.fail();
      }
      return;
    }
    if (tool === 'wall') {
      // клик по существующей стене — выбрать и тянуть; иначе рисуем НОВУЮ протягиванием
      const wi = wallAtPoint(m, w.x, w.y);
      if (wi >= 0) {
        const wl = (m.walls ?? [])[wi];
        objDragRef.current = { kind: 'wall', idx: wi, dx: w.x - wl.x, dy: w.y - wl.y, moved: false };
        setSelWall(wi);
        setSelCell(null);
        setSelStamp(null);
        setSelAnim(null);
        setSelBoss(null);
        sfx.hover();
        return;
      }
      setSelWall(null);
      wallDragRef.current = { sx: w.x, sy: w.y, ex: w.x, ey: w.y };
      return;
    }
    if (tool === 'portal') {
      // режим «указать точку перехода»: ЛЮБОЙ клик по канве ставит точку (плитку можно
      // переключить в панели «Плитки и порталы» — навигатор двигает камеру, не кликает по канве)
      if (pickTargetFor !== null) {
        const pi = pickTargetFor;
        setPickTargetFor(null);
        if ((m.portals ?? [])[pi]) {
          updPortal(pi, { tx: Math.round(w.x), ty: Math.round(w.y) });
          setSelPortal(pi);
          dirtyRef.current = true;
          sfx.step();
          toast(`Точка портала ${pi + 1} указана (плитка ${plateNumOf(w.x, w.y)}): фишка войдёт в зону — и перенесётся сюда`, 'ok');
        }
        return;
      }
      // клик по существующему порталу — выбрать и тянуть
      const pi = portalAtPoint(m, w.x, w.y);
      if (pi >= 0) {
        const pz = (m.portals ?? [])[pi];
        objDragRef.current = { kind: 'portal', idx: pi, dx: w.x - pz.x, dy: w.y - pz.y, moved: false };
        setSelPortal(pi);
        setSelCell(null);
        setSelStamp(null);
        setSelAnim(null);
        setSelBoss(null);
        setSelWall(null);
        sfx.hover();
        return;
      }
      setSelPortal(null);
      portalDragRef.current = { sx: w.x, sy: w.y, ex: w.x, ey: w.y };
      return;
    }
  };

  /* стереть верхний тайл под точкой (для ластика) */
  const eraseAt = (m: GameMap, wx: number, wy: number) => {
    const si = stampAtPoint(m, wx, wy);
    if (si < 0) return false;
    forgetStamp(si);
    setMap((mm) => (mm ? { ...mm, stamps: (mm.stamps ?? []).filter((_, i) => i !== si) } : mm));
    dirtyRef.current = true;
    return true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const m = mapRef.current;
    if (!m) return;
    const w = toWorld(e);
    setHoverW(w);
    if (dragRef.current) {
      const d = dragRef.current;
      setView((v) => ({ ...v, x: d.vx - (e.clientX - d.sx) / v.zoom, y: d.vy - (e.clientY - d.sy) / v.zoom }));
      return;
    }
    if (resizeRef.current) {
      // тянем уголок: новый размер = 2 × расстояние от центра (центр на месте)
      if (resizeRef.current.kind === 'stamp') {
        const s = (m.stamps ?? [])[resizeRef.current.idx];
        if (s) {
          const rot = s.rot % 2 === 1;
          let vw = Math.max(8, Math.abs(w.x - s.x) * 2);
          let vh = Math.max(8, Math.abs(w.y - s.y) * 2);
          vw = Math.round(vw / 2) * 2;
          vh = Math.round(vh / 2) * 2;
          updStamp(resizeRef.current.idx, rot ? { w: vh, h: vw } : { w: vw, h: vh });
          dirtyRef.current = true;
        }
      } else if (resizeRef.current.kind === 'boss') {
        const b = (m.bosses ?? [])[resizeRef.current.idx];
        if (b) {
          let vw = Math.max(12, Math.abs(w.x - b.x) * 2);
          let vh = Math.max(12, Math.abs(w.y - b.y) * 2);
          updBoss(resizeRef.current.idx, { w: Math.round(vw / 2) * 2, h: Math.round(vh / 2) * 2 });
          dirtyRef.current = true;
        }
      } else {
        const a = (m.anims ?? [])[resizeRef.current.idx];
        if (a) {
          let vw = Math.max(12, Math.abs(w.x - a.x) * 2);
          let vh = Math.max(12, Math.abs(w.y - a.y) * 2);
          updAnim(resizeRef.current.idx, { w: Math.round(vw / 2) * 2, h: Math.round(vh / 2) * 2 });
          dirtyRef.current = true;
        }
      }
      return;
    }
    if (objDragRef.current) {
      const od = objDragRef.current;
      const p = snapPt(w.x - od.dx, w.y - od.dy);
      od.moved = true;
      dirtyRef.current = true;
      if (od.kind === 'cell') updCell(od.idx, { cx: Math.round(p.x), cy: Math.round(p.y) });
      else if (od.kind === 'anim') updAnim(od.idx, { x: Math.round(p.x), y: Math.round(p.y) });
      else if (od.kind === 'boss') updBoss(od.idx, { x: Math.round(p.x), y: Math.round(p.y) });
      else if (od.kind === 'wall') updWall(od.idx, { x: Math.round(w.x - od.dx), y: Math.round(w.y - od.dy) }); // стены — без привязки к сетке
      else if (od.kind === 'portal') updPortal(od.idx, { x: Math.round(w.x - od.dx), y: Math.round(w.y - od.dy) }); // порталы — без привязки к сетке (точка перехода остаётся на месте)
      else updStamp(od.idx, { x: Math.round(p.x), y: Math.round(p.y) });
      return;
    }
    if (wallDragRef.current) {
      // протягиваем НОВУЮ стену — обновляем второй угол (рисуется в цикле отрисовки)
      wallDragRef.current.ex = w.x;
      wallDragRef.current.ey = w.y;
      return;
    }
    if (portalDragRef.current) {
      // протягиваем НОВУЮ зону портала — обновляем второй угол (рисуется в цикле отрисовки)
      portalDragRef.current.ex = w.x;
      portalDragRef.current.ey = w.y;
      return;
    }
    if (tool === 'erase' && e.buttons === 1) {
      // протягиваем ластик — стираем всё под курсором
      if (eraseAt(m, w.x, w.y) && Date.now() - lastEraseSfxRef.current > 180) {
        lastEraseSfxRef.current = Date.now();
        sfx.fail();
      }
      return;
    }
    if (tool === 'tile' && e.buttons === 1 && lastPlaceRef.current) {
      // тянем с зажатой кнопкой — ставим тайлы через равные промежутки
      const lp = lastPlaceRef.current;
      if (Math.hypot(w.x - lp.x, w.y - lp.y) > 48) {
        placeStamp(w.x, w.y);
        lastPlaceRef.current = { x: w.x, y: w.y };
      }
    }
  };

  const onPointerUp = () => {
    dragRef.current = null;
    objDragRef.current = null;
    resizeRef.current = null;
    lastPlaceRef.current = null;
    /* СТЕНА: фиксируем протянутый прямоугольник (минимум 12×12 px);
       отрицательные размеры нормализуем (протягивание вверх/влево) */
    const wd = wallDragRef.current;
    wallDragRef.current = null;
    if (wd) {
      const wx = Math.round(Math.min(wd.sx, wd.ex));
      const wy = Math.round(Math.min(wd.sy, wd.ey));
      const ww = Math.round(Math.abs(wd.ex - wd.sx));
      const wh = Math.round(Math.abs(wd.ey - wd.sy));
      if (ww >= 12 && wh >= 12 && mapRef.current) {
        const newIdx = (mapRef.current.walls ?? []).length;
        const wl: WallRect = { x: wx, y: wy, w: ww, h: wh };
        setMap((mm) => (mm ? { ...mm, walls: [...(mm.walls ?? []), wl] } : mm));
        setSelWall(newIdx);
        dirtyRef.current = true;
        sfx.step();
        toast('Стена готова: в игре она НЕВИДИМА — фишка не сможет зайти внутрь (действует в JOURNEY)', 'ok');
      }
    }
    /* ПОРТАЛ: фиксируем протянутую зону входа (минимум 12×12 px) и сразу предлагаем
       кликнуть по карте — куда переносить (точку можно ставить на любой плитке) */
    const pd = portalDragRef.current;
    portalDragRef.current = null;
    if (pd) {
      const px = Math.round(Math.min(pd.sx, pd.ex));
      const py = Math.round(Math.min(pd.sy, pd.ey));
      const pw = Math.round(Math.abs(pd.ex - pd.sx));
      const ph = Math.round(Math.abs(pd.ey - pd.sy));
      if (pw >= 12 && ph >= 12 && mapRef.current) {
        const newIdx = (mapRef.current.portals ?? []).length;
        const pz: PortalZone = { id: uid('pz'), x: px, y: py, w: pw, h: ph };
        setMap((mm) => (mm ? { ...mm, portals: [...(mm.portals ?? []), pz] } : mm));
        setSelPortal(newIdx);
        setPickTargetFor(newIdx);
        dirtyRef.current = true;
        sfx.step();
        toast(`Зона портала ${newIdx + 1} готова — теперь кликните по карте, КУДА переносить (плитку можно переключить в панели «Плитки и порталы»; Esc — отложить)`, 'info');
      }
    }
    void persistIfDirty();
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const v = viewRef.current;
    const wx = v.x + (e.clientX - r.left - r.width / 2) / v.zoom;
    const wy = v.y + (e.clientY - r.top - r.height / 2) / v.zoom;
    const z2 = Math.min(4, Math.max(0.12, v.zoom * Math.exp(-e.deltaY * 0.0012)));
    setView({ x: wx - (wx - v.x) * (v.zoom / z2), y: wy - (wy - v.y) * (v.zoom / z2), zoom: z2 });
  };

  /* ---------- горячие клавиши ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') { setLinkFrom(null); setSelCell(null); setSelStamp(null); setSelAnim(null); setSelBoss(null); setSelWall(null); setSelPortal(null); setPickTargetFor(null); setPlaceAnimId(''); return; }
      if (!map) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (e.repeat) return; // удержание обрабатывает useKeyDelete (режим «долгое нажатие»)
        if (selStamp && selStampIdx >= 0) {
          const st = map.stamps![selStampIdx];
          keyDel.keyDeleteStart(`тайл «${tileImgById.get(st.tid)?.name ?? 'с карты'}» с карты`, () => deleteStampNow(selStampIdx));
        } else if (selAnim) {
          const an = (map.anims ?? []).find((a) => a.id === selAnim);
          keyDel.keyDeleteStart(`анимацию «${(map.animLib ?? []).find((x) => x.id === an?.aid)?.name ?? 'с карты'}»`, () => removeAnim(selAnim));
        } else if (selBoss) {
          const b = (map.bosses ?? []).find((x) => x.id === selBoss);
          keyDel.keyDeleteStart(`босса «${(map.bossLib ?? []).find((x) => x.id === b?.bid)?.name ?? 'с карты'}»`, () => removeBossAt(selBoss));
        } else if (selWall !== null && (map.walls ?? [])[selWall]) {
          keyDel.keyDeleteStart('стену с карты', () => removeWall(selWall));
        } else if (selPortal !== null && (map.portals ?? [])[selPortal]) {
          keyDel.keyDeleteStart(`портал ${selPortal + 1} с карты`, () => removePortal(selPortal));
        } else if (selCell !== null) {
          keyDel.keyDeleteStart('ячейку маршрута', () => deleteCell(selCell));
        }
        return;
      }
      if (e.key.toLowerCase() === 'r' && selStamp && selStampIdx >= 0) {
        updStamp(selStampIdx, { rot: ((map.stamps?.[selStampIdx].rot ?? 0) + 1) % 4 });
        dirtyRef.current = true;
        sfx.hover();
      }
      if (e.key.toLowerCase() === 'f' && selStamp && selStampIdx >= 0) {
        updStamp(selStampIdx, { flip: !(map.stamps?.[selStampIdx].flip ?? false) });
        dirtyRef.current = true;
        sfx.hover();
      }
    };
    /* отпустили Delete в режиме «долгое нажатие» — отменяем удержание */
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') keyDel.keyDeleteCancel(true);
    };
    /* окно потеряло фокус — не оставляем «зависшее» удержание */
    const onBlur = () => keyDel.keyDeleteCancel(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selCell, selStamp, selStampIdx, selAnim]);

  /* ---------- цикл отрисовки ---------- */
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
          tileById: legacyTileById, captured: {}, colorById: {},
          currentCell: startCellIdx(m),
          showNumbers: true, tokens: [], time: t,
          hoverCell: null,
          sndRadii: true, // пунктирные круги радиусов звука — только в редакторе
        });
        const v = viewRef.current;
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.scale(v.zoom, v.zoom);
        ctx.translate(-v.x, -v.y);

        // редакторская сетка поверх (включается тумблером)
        if (showGrid) {
          ctx.strokeStyle = 'rgba(90,169,255,0.16)';
          ctx.lineWidth = 1 / v.zoom;
          for (let x = 0; x <= m.mw!; x += CELL) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, m.mh!); ctx.stroke();
          }
          for (let y = 0; y <= m.mh!; y += CELL) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(m.mw!, y); ctx.stroke();
          }
        }

        // ПЛИТКИ: пунктирные границы страниц + подписи «Плитка N» (только при разбивке)
        const PSz = m.plateSize ?? 0;
        if (PSz) {
          ctx.save();
          ctx.setLineDash([18 / v.zoom, 12 / v.zoom]);
          ctx.strokeStyle = 'rgba(90,169,255,0.4)';
          ctx.lineWidth = 2 / v.zoom;
          for (let x = PSz; x < m.mw!; x += PSz) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, m.mh!); ctx.stroke();
          }
          for (let y = PSz; y < m.mh!; y += PSz) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(m.mw!, y); ctx.stroke();
          }
          ctx.restore();
          const fs = 11 / v.zoom;
          ctx.font = `${fs}px "Press Start 2P", monospace`;
          ctx.textAlign = 'left';
          const cols = Math.ceil(m.mw! / PSz), rows = Math.ceil(m.mh! / PSz);
          const pad = 8 / v.zoom;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const label = `Плитка ${r * cols + c + 1}`;
              const lx = c * PSz + pad + 2, ly = r * PSz + pad + fs;
              ctx.fillStyle = 'rgba(7,9,18,0.75)';
              ctx.fillRect(c * PSz + pad, r * PSz + pad, label.length * fs * 1.12 + pad * 2, fs + pad * 2);
              ctx.fillStyle = 'rgba(122,183,255,0.9)';
              ctx.fillText(label, lx, ly);
            }
          }
        }

        // ПЛИТОЧНЫЙ РЕЖИМ КАРТ: рамки и подписи карт-плиток; активная — золотая
        const TGz = m.tileGrid;
        if (TGz && TGz.tiles.length) {
          ctx.save();
          ctx.font = `${11 / v.zoom}px "Press Start 2P", monospace`;
          ctx.textAlign = 'left';
          const pad = 8 / v.zoom;
          TGz.tiles.forEach((t, i) => {
            const r0 = tileRectOf(TGz, t);
            const isActive = activeTile?.id === t.id;
            ctx.save();
            ctx.setLineDash([16 / v.zoom, 10 / v.zoom]);
            ctx.strokeStyle = isActive ? 'rgba(255,207,63,0.95)' : 'rgba(46,230,168,0.45)';
            ctx.lineWidth = (isActive ? 3 : 2) / v.zoom;
            ctx.strokeRect(r0.x, r0.y, r0.w, r0.h);
            ctx.restore();
            const label = `КАРТА ${i + 1}`;
            ctx.fillStyle = 'rgba(7,9,18,0.75)';
            ctx.fillRect(r0.x + pad, r0.y + pad, label.length * (11 / v.zoom) * 1.12 + pad * 2, (11 / v.zoom) + pad * 2);
            ctx.fillStyle = isActive ? 'rgba(255,207,63,0.95)' : 'rgba(46,230,168,0.85)';
            ctx.fillText(label, r0.x + pad + 2, r0.y + pad + 11 / v.zoom);
          });
          ctx.restore();
        }

        // НЕВИДИМЫЕ СТЕНЫ: коралловая штриховка — видна ТОЛЬКО в редакторе (в игре их нет)
        const drawWallRect = (x: number, y: number, w: number, h: number, selected: boolean) => {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          ctx.fillStyle = 'rgba(255,93,115,0.13)';
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = 'rgba(255,93,115,0.45)';
          ctx.lineWidth = 1.5 / v.zoom;
          const step = 14;
          for (let d = -h; d < w; d += step) {
            ctx.beginPath();
            ctx.moveTo(x + d, y);
            ctx.lineTo(x + d + h, y + h);
            ctx.stroke();
          }
          ctx.restore();
          ctx.strokeStyle = selected ? '#ffcf3f' : 'rgba(255,93,115,0.85)';
          ctx.lineWidth = (selected ? 3 : 2) / v.zoom;
          ctx.strokeRect(x, y, w, h);
        };
        for (let wi = 0; wi < (m.walls ?? []).length; wi++) {
          const wl = m.walls![wi];
          drawWallRect(wl.x, wl.y, wl.w, wl.h, selWall === wi);
        }
        if (wallDragRef.current) {
          const wd = wallDragRef.current;
          drawWallRect(Math.min(wd.sx, wd.ex), Math.min(wd.sy, wd.ey), Math.abs(wd.ex - wd.sx), Math.abs(wd.ey - wd.sy), true);
        }

        // ПОРТАЛЫ: сиреневая зона входа + пунктир к точке перехода + маркер точки + подпись
        const drawPortalZone = (pz: PortalZone, idx: number, selected: boolean) => {
          const cx = pz.x + pz.w / 2, cy = pz.y + pz.h / 2;
          const hasT = pz.tx !== undefined && pz.ty !== undefined;
          if (hasT) {
            // пунктир от центра зоны к точке перехода
            ctx.save();
            ctx.setLineDash([8 / v.zoom, 6 / v.zoom]);
            ctx.strokeStyle = selected ? 'rgba(255,207,63,0.9)' : 'rgba(192,122,255,0.75)';
            ctx.lineWidth = 2 / v.zoom;
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(pz.tx!, pz.ty!); ctx.stroke();
            ctx.restore();
            // маркер точки перехода: окружность + крест
            const R = Math.max(6, 9 / v.zoom);
            ctx.save();
            ctx.strokeStyle = selected ? '#ffcf3f' : '#c07aff';
            ctx.lineWidth = (selected ? 3 : 2) / v.zoom;
            ctx.beginPath(); ctx.arc(pz.tx!, pz.ty!, R, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(pz.tx! - R * 1.8, pz.ty!); ctx.lineTo(pz.tx! + R * 1.8, pz.ty!);
            ctx.moveTo(pz.tx!, pz.ty! - R * 1.8); ctx.lineTo(pz.tx!, pz.ty! + R * 1.8);
            ctx.stroke();
            ctx.restore();
          }
          // зона входа
          ctx.save();
          ctx.beginPath();
          ctx.rect(pz.x, pz.y, pz.w, pz.h);
          ctx.fillStyle = 'rgba(192,122,255,0.15)';
          ctx.fill();
          ctx.setLineDash([10 / v.zoom, 7 / v.zoom]);
          ctx.strokeStyle = selected ? '#ffcf3f' : 'rgba(192,122,255,0.9)';
          ctx.lineWidth = (selected ? 3 : 2) / v.zoom;
          ctx.stroke();
          ctx.restore();
          // вихрь в центре зоны (не рисуем, если зона крошечная)
          if (pz.w > 26 && pz.h > 26) {
            const R = Math.min(pz.w, pz.h) * 0.28;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(t / 900);
            ctx.strokeStyle = 'rgba(216,180,255,0.85)';
            ctx.lineWidth = 2 / v.zoom;
            for (const rr of [R, R * 0.55]) {
              ctx.beginPath();
              ctx.arc(0, 0, rr, 0.35, Math.PI * 1.45);
              ctx.stroke();
            }
            ctx.restore();
          }
          // подпись
          const fs = 8 / v.zoom;
          const label = `ПОРТАЛ ${idx + 1}${hasT ? (PSz ? ` → ПЛИТКА ${plateNumOf(pz.tx!, pz.ty!)}` : ' → ТОЧКА') : ' — укажите ТОЧКУ!'}`;
          ctx.save();
          ctx.font = `${fs}px "Press Start 2P", monospace`;
          ctx.textAlign = 'left';
          const tw = label.length * fs * 1.12 + 6 / v.zoom;
          ctx.fillStyle = 'rgba(7,9,18,0.8)';
          ctx.fillRect(cx - tw / 2, pz.y + pz.h + 3 / v.zoom, tw, fs + 5 / v.zoom);
          ctx.fillStyle = selected ? '#ffcf3f' : 'rgba(216,180,255,0.95)';
          ctx.fillText(label, cx - tw / 2 + 3 / v.zoom, pz.y + pz.h + 3 / v.zoom + fs + 2 / v.zoom);
          ctx.restore();
        };
        for (let pi = 0; pi < (m.portals ?? []).length; pi++) {
          drawPortalZone(m.portals![pi], pi, selPortal === pi);
        }
        if (portalDragRef.current) {
          const pd = portalDragRef.current;
          const dx0 = Math.min(pd.sx, pd.ex), dy0 = Math.min(pd.sy, pd.ey);
          ctx.save();
          ctx.beginPath();
          ctx.rect(dx0, dy0, Math.abs(pd.ex - pd.sx), Math.abs(pd.ey - pd.sy));
          ctx.fillStyle = 'rgba(192,122,255,0.15)';
          ctx.fill();
          ctx.setLineDash([10 / v.zoom, 7 / v.zoom]);
          ctx.strokeStyle = '#ffcf3f';
          ctx.lineWidth = 2.5 / v.zoom;
          ctx.stroke();
          ctx.restore();
        }

        // выделенный штамп: рамка с учётом поворота + жёлтые угловые ручки (ресайз)
        const sIdx = (m.stamps ?? []).findIndex((s) => s.id === selStamp);
        if (sIdx >= 0) {
          const s = m.stamps![sIdx];
          const rot = s.rot % 2 === 1;
          const vw = rot ? s.h : s.w, vh = rot ? s.w : s.h;
          const hs = 6.5 / v.zoom;
          ctx.strokeStyle = '#ffcf3f';
          ctx.lineWidth = 2.5 / v.zoom;
          ctx.setLineDash([6 / v.zoom, 4 / v.zoom]);
          ctx.strokeRect(s.x - vw / 2 - 3, s.y - vh / 2 - 3, vw + 6, vh + 6);
          ctx.setLineDash([]);
          for (const [ox, oy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
            const hx = s.x + (ox * (vw + 6)) / 2;
            const hy = s.y + (oy * (vh + 6)) / 2;
            ctx.fillStyle = '#ffcf3f';
            ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
            ctx.strokeStyle = 'rgba(7,9,18,0.9)';
            ctx.lineWidth = 1.5 / v.zoom;
            ctx.strokeRect(hx - hs, hy - hs, hs * 2, hs * 2);
          }
        }
        // выделенная анимация: рамка + жёлтые угловые ручки (ресайз) — как у тайла
        const aIdx = (m.anims ?? []).findIndex((a) => a.id === selAnim);
        if (aIdx >= 0) {
          const a = m.anims![aIdx];
          const hs = 6.5 / v.zoom;
          ctx.strokeStyle = '#ffcf3f';
          ctx.lineWidth = 2.5 / v.zoom;
          ctx.setLineDash([6 / v.zoom, 4 / v.zoom]);
          ctx.strokeRect(a.x - a.w / 2 - 3, a.y - a.h / 2 - 3, a.w + 6, a.h + 6);
          ctx.setLineDash([]);
          for (const [ox, oy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
            const hx = a.x + (ox * (a.w + 6)) / 2;
            const hy = a.y + (oy * (a.h + 6)) / 2;
            ctx.fillStyle = '#ffcf3f';
            ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
            ctx.strokeStyle = 'rgba(7,9,18,0.9)';
            ctx.lineWidth = 1.5 / v.zoom;
            ctx.strokeRect(hx - hs, hy - hs, hs * 2, hs * 2);
          }
        }
        // выделенная ячейка
        if (selCell !== null && m.cells[selCell]) {
          const b = cellBox(m, selCell);
          ctx.strokeStyle = '#5aa9ff';
          ctx.lineWidth = 3 / v.zoom;
          ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
        }
        // источник стрелки + призрак стрелки
        if (linkFrom !== null && m.cells[linkFrom]) {
          const b = cellBox(m, linkFrom);
          ctx.strokeStyle = '#ffcf3f';
          ctx.lineWidth = 3.5 / v.zoom;
          ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
          if (hoverW) {
            const hi = cellAtPoint(m, hoverW.x, hoverW.y);
            if (hi >= 0 && hi !== linkFrom) {
              const a = cellCenter(m, linkFrom);
              const c = cellCenter(m, hi);
              ctx.strokeStyle = 'rgba(255,207,63,0.9)';
              ctx.lineWidth = 3 / v.zoom;
              ctx.setLineDash([8 / v.zoom, 6 / v.zoom]);
              ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
              ctx.setLineDash([]);
            }
          }
        }
        // призрак тайла под курсором
        if (hoverW && toolRef.current === 'tile' && ghostRef.current) {
          const gi = ghostRef.current;
          ctx.globalAlpha = 0.5;
          ctx.drawImage(gi, hoverW.x - gi.width / 2, hoverW.y - gi.height / 2, gi.width, gi.height);
          ctx.globalAlpha = 1;
        }
        // призрак анимации под курсором (первый кадр)
        if (hoverW && toolRef.current === 'anim' && ghostAnimRef.current && !animAtPoint(m, hoverW.x, hoverW.y)) {
          const gi = ghostAnimRef.current;
          ctx.globalAlpha = 0.5;
          ctx.drawImage(gi, hoverW.x - gi.width / 2, hoverW.y - gi.height / 2, gi.width, gi.height);
          ctx.globalAlpha = 1;
        }
        // курсор-ластик: крестик под мышью
        if (hoverW && toolRef.current === 'erase') {
          const r = 14 / v.zoom;
          ctx.strokeStyle = 'rgba(255,93,115,0.95)';
          ctx.lineWidth = 2 / v.zoom;
          ctx.beginPath();
          ctx.moveTo(hoverW.x - r, hoverW.y - r); ctx.lineTo(hoverW.x + r, hoverW.y + r);
          ctx.moveTo(hoverW.x + r, hoverW.y - r); ctx.lineTo(hoverW.x - r, hoverW.y + r);
          ctx.stroke();
          ctx.strokeRect(hoverW.x - r, hoverW.y - r, r * 2, r * 2);
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [legacyTileById, showGrid, selCell, selStamp, selStampIdx, selAnim, linkFrom, hoverW, tileId, selWall]);

  /* ─── панели ─── */
  const saveMap = async () => {
    if (!map) return;
    await persist(map);
    toast('Карта сохранена', 'ok');
  };

  /** ПРИМЕНЕНИЕ СВОЕГО ЧЕЛЛЕНДЖА (мастер «Создать челлендж»): режим + ресурсы +
     МОНЕТЫ + штрафы/награды + размер поля (только на пустой карте) + плиточный режим. */
  const applyChallenge = (cc: CustomChallenge) => {
    const m = mapRef.current;
    if (!m) return;
    const r = cc.resolved;
    /* БЕЗКАРТОВЫЙ челлендж к карте не применяется — он играется из «Создания игры» */
    if (r.mapless) {
      sfx.fail();
      toast(`«${cc.name}» — челлендж БЕЗ КАРТЫ. Он не применяется к карте: запустите его в «Создание игры», секция «Челленджи без карты»`, 'err');
      return;
    }
    const empty = m.cells.length === 0 && (m.stamps ?? []).length === 0;
    const patch: Partial<GameMap> = {
      mode: r.baseMode,
      startMin: r.startMin,
      startTries: r.startTries,
      moveSpeed: r.speed,
      customId: cc.id,
      customName: cc.name,
      startCoins: r.resCoins ? Math.max(0, r.startCoins) : undefined,
      coinsOnly: r.resCoins && r.coinsOnly ? true : undefined,
      taskWinCoins: r.resCoins ? r.taskWinCoins : undefined,
      skipCoins: r.resCoins ? r.skipCoins : undefined,
      quizWinCoins: r.resCoins ? r.quizWinCoins : undefined,
      quizLoseCoins: r.resCoins ? r.quizLoseCoins : undefined,
      loseMin: r.loseMin || undefined,
      loseTries: r.loseTries || undefined,
      winMin: r.winMin || undefined,
      winTries: r.winTries || undefined,
    };
    let extra = '';
    if (r.resCoins) extra += ` Монеты: старт ${coinsStr(r.startCoins)}, +${r.taskWinCoins} бр за победу, пропуск ${r.skipCoins} бр.`;
    if (empty) {
      patch.mw = r.mw;
      patch.mh = r.mh;
      if (r.tileMode && !m.tileGrid) {
        patch.tileGrid = { w: r.mw, h: r.mh, tiles: [{ id: uid('mt'), col: 0, row: 0 }] };
        extra = ' Включён плиточный режим — добавляйте карты-плитки в спойлере «Карты-плитки».';
        setSelTileId((patch.tileGrid as TileGrid).tiles[0].id);
      }
    } else {
      extra = ' Размер поля не тронут — карта уже не пуста.';
    }
    updMap(patch);
    sfx.coin();
    toast(`Свой режим «${cc.name}» применён: ${MAP_MODES.find((x) => x.id === r.baseMode)?.name ?? r.baseMode}, ${r.startMin} мин / ${r.startTries} поп.${extra}`, 'ok');
  };

  const finish = async () => {
    if (!map) return;
    const starts = map.cells.filter((c) => c.type === 'start').length;
    if (map.cells.length < 10) {
      sfx.fail();
      toast(`Нужно минимум 10 ячеек (сейчас ${map.cells.length})`, 'err');
      return;
    }
    /* RUBG: стартовая ячейка НЕ ОБЯЗАТЕЛЬНА — бойцы выпрыгивают из самолёта, где хотят */
    if (starts === 0 && (map.mode ?? 'classic') !== 'rubg') {
      sfx.fail();
      toast('Поставьте стартовую ячейку: выберите ячейку и задайте тип «Старт» — с неё начнут все игроки', 'err');
      return;
    }
    if (starts > 1) {
      sfx.fail();
      toast('Стартовая ячейка должна быть ОДНА — лишние переключите в другой тип', 'err');
      return;
    }
    /* SKILL CHALLENGE: каждый ход — задание. Ячейки квизов/бонусов/штрафов/отдыха запрещены */
    if ((map.mode ?? 'classic') === 'skill') {
      const bad = map.cells.filter((c) => c.type === 'quiz' || c.type === 'bonus' || c.type === 'trap' || c.type === 'rest').length;
      if (bad > 0) {
        sfx.fail();
        toast(`SKILL CHALLENGE: каждый ход должен быть с заданием — на карте ${bad} яч. квизов/бонусов/штрафов/отдыха. Измените режим карты или уберите эти ячейки`, 'err');
        return;
      }
    }
    /* RUBG: задания + лутбоксы. Квизы/бонусы/ловушки/отдых запрещены (лутбоксы заменяют бонусы/ловушки),
       монеты запрещены — в RUBG ресурс ОДИН: полоска HP */
    if ((map.mode ?? 'classic') === 'rubg') {
      const bad = map.cells.filter((c) => c.type === 'quiz' || c.type === 'bonus' || c.type === 'trap' || c.type === 'rest').length;
      if (bad > 0) {
        sfx.fail();
        toast(`RUBG: ячейки квизов/бонусов/штрафов/отдыха недоступны (лутбоксы заменяют бонусы/ловушки) — на карте ${bad} таких. Уберите их или измените режим`, 'err');
        return;
      }
      const lootCnt = map.cells.filter((c) => c.type === 'loot').length;
      if (lootCnt === 0) {
        sfx.fail();
        toast('RUBG: на карте нет ни одного ЛУТБОКСА — игрокам нечем лечиться и нечем атаковать. Поставьте лутбоксы (тип ячейки «Лут.»)', 'err');
        return;
      }
      /* RUBG: ресурс — только «Полоска HP»: молча исправляем старые карты (монеты выключаем) */
      if (map.startCoins !== undefined || map.coinsOnly || map.resMode !== 'hp') {
        updMap({ resMode: 'hp', coinsOnly: undefined, startCoins: undefined });
      }
    } else if (map.cells.some((c) => c.type === 'loot')) {
      sfx.fail();
      toast('Ячейки-лутбоксы работают только в режиме RUBG — измените тип ячеек или включите режим RUBG', 'err');
      return;
    }
    /* НЕВИДИМЫЕ СТЕНЫ работают только в TRIATHLON/JOURNEY: карта со стенами в другом режиме не завершается.
     Удалить все стены разом — кнопка в левой панели «Невидимые стены» */
    const wallCnt = (map.walls ?? []).length;
    if (wallCnt > 0 && !isJourneyLike(map.mode)) {
      sfx.fail();
      toast(`На карте ${wallCnt} невидимых стен, но они работают только в TRIATHLON/JOURNEY. Измените режим игры или удалите все стены (кнопка «Удалить все стены разом» в панели слева)`, 'err');
      return;
    }
    /* ПЛИТОЧНЫЙ РЕЖИМ: ячейки ВНЕ карт-плиток недостижимы в игре — карта не завершается */
    if (map.tileGrid) {
      const tg = map.tileGrid;
      const outside = map.cells.filter((c, ci) => {
        const cc = cellCenter(map, ci);
        return !tg.tiles.some((t) => {
          const r = tileRectOf(tg, t);
          return cc.x >= r.x && cc.x < r.x + r.w && cc.y >= r.y && cc.y < r.y + r.h;
        });
      }).length;
      if (outside > 0) {
        sfx.fail();
        toast(`${outside} ячеек лежат ВНЕ карт-плиток — в игре фишка до них не дойдёт. Уберите плиточный режим, верните плитку или передвиньте ячейки`, 'err');
        return;
      }
      const pOut = (map.portals ?? []).filter((p) => p.tx !== undefined && p.ty !== undefined && !tg.tiles.some((t) => {
        const r = tileRectOf(tg, t);
        return p.tx! >= r.x && p.tx! < r.x + r.w && p.ty! >= r.y && p.ty! < r.y + r.h;
      })).length;
      if (pOut > 0) {
        sfx.fail();
        toast(`У ${pOut} портала(ов) точка перехода ВНЕ карт-плиток — укажите заново (клик по порталу → «Указать точку перехода заново»)`, 'err');
        return;
      }
    }
    /* ПОРТАЛЫ: у каждого должна быть точка перехода — иначе фишка перенесётся «в никуда» */
    const noTgt = (map.portals ?? []).filter((p) => p.tx === undefined || p.ty === undefined).length;
    if (noTgt > 0) {
      sfx.fail();
      toast(`У ${noTgt} портала(ов) не указана точка перехода: инструмент «Портал» → клик по порталу → кнопка «Указать точку перехода заново» в панели «Плитки и порталы», затем кликните по карте`, 'err');
      return;
    }
    await persist(map);
    setNameDraft(map.ready ? map.name : '');
    setNameModal(true);
  };

  const confirmFinish = async () => {
    if (!map) return;
    const name = nameDraft.trim();
    if (!name) { toast('Введите название карты', 'err'); return; }
    const done = { ...map, name: name.toUpperCase(), ready: true };
    await idbPut('maps', done.id, done);
    await refresh();
    setMap(done);
    setNameModal(false);
    sfx.success();
    toast(`Карта «${name}» сохранена`, 'ok');
  };

  const removeMap = async (id: string) => {
    const victim = maps.find((x) => x.id === id) ?? (map?.id === id ? map : null);
    const wasOpen = map?.id === id;
    if (victim) {
      const snap = JSON.parse(JSON.stringify(victim)) as GameMap;
      rememberDeleted({
        label: `карту «${snap.name}»`,
        restore: async () => {
          await idbPut('maps', snap.id, JSON.parse(JSON.stringify(snap)));
          await useApp.getState().refresh();
          if (wasOpen) setMap(migrateMap(JSON.parse(JSON.stringify(snap)), tiles)); // вернём и reopened
        },
      });
    }
    await idbDel('maps', id);
    await refresh();
    if (wasOpen) setMap(null);
    toast('Карта удалена', 'err');
  };

  const resizeField = (axis: 'mw' | 'mh', v: number) => updMap({ [axis]: v } as Partial<GameMap>);

  const selCellDef = map && selCell !== null && selCell < map.cells.length ? map.cells[selCell] : null;
  const selStampDef = map && selStampIdx >= 0 ? map.stamps![selStampIdx] : null;
  const selTileDef = tileImgById.get(selStampDef?.tid ?? '');
  const selAnimIdx = map ? (map.anims ?? []).findIndex((a) => a.id === selAnim) : -1;
  const selAnimDef = map && selAnimIdx >= 0 ? map.anims![selAnimIdx] : null;
  const selAnimLib = map && selAnimDef ? (map.animLib ?? []).find((x) => x.id === selAnimDef.aid) : null;
  const selBossIdx = map ? (map.bosses ?? []).findIndex((b) => b.id === selBoss) : -1;
  const selBossDef = map && selBossIdx >= 0 ? map.bosses![selBossIdx] : null;
  const selBossLib = map && selBossDef ? (map.bossLib ?? []).find((x) => x.id === selBossDef.bid) : null;
  const startsCount = map?.cells.filter((c) => c.type === 'start').length ?? 0;
  const taskCells = map?.cells.filter((c) => c.type === 'task').length ?? 0;
  const noTask = map?.cells.filter((c) => c.type === 'task' && !c.task).length ?? 0;
  const restCells = map?.cells.filter((c) => c.type === 'rest').length ?? 0;
  const msz = map ? mapSize(map) : { w: 0, h: 0 };
  /* фон плиток: номер плитки под камерой, сколько плиток со своим фоном, что редактируем */
  const curPlateNum = curPlateIdx + 1;
  const plateBgCount = map?.plateBgs ? Object.keys(map.plateBgs).length : 0;
  const bgIsPlate = !!(map && map.plateSize && !map.tileGrid && bgScope === 'plate');
  const plateBgCur = map?.plateSize ? (map.plateBgs ?? {})[curPlateNum] : undefined;
  const bgIsTile = !!(map && map.tileGrid && bgScope === 'plate');
  const tileBgCur = map && map.tileGrid && activeTile ? (map.tileBgs ?? {})[activeTile.id] : undefined;
  const activeTileNum = map?.tileGrid && activeTile ? map.tileGrid.tiles.findIndex((t) => t.id === activeTile.id) + 1 : 0;

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
              <GhostBtn onClick={() => void saveMap()}>{Ic.save(14)} Сохранить</GhostBtn>
              <PxBtn color="teal" onClick={() => void finish()}>{Ic.check(14)} Карта создана</PxBtn>
            </>
          )}
          {!map && <PxBtn color="teal" onClick={newMap}>+ Новая карта</PxBtn>}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* левая колонка: карты + фон + тайлы */}
        <div className="w-[248px] shrink-0 border-r-[3px] border-edge bg-[rgba(11,14,28,0.75)] overflow-y-auto p-3 space-y-4 hidden md:block">
          <div>
            <div className="tick-label mb-2">Мои карты · {maps.length}</div>
            <div className="space-y-1.5">
              {maps.map((m) => (
                <div key={m.id} className={`flex items-stretch border-2 ${map?.id === m.id ? 'border-gold bg-[rgba(255,207,63,0.08)]' : 'border-edge hover:border-edge2 bg-panel'}`}>
                  <button onClick={() => openMap(m)} className="flex-1 min-w-0 text-left px-3 py-2 cursor-pointer">
                    <div className="font-display text-[11px] uppercase text-paper truncate">{m.name}</div>
                    <div className="tick-label text-faint mt-0.5">{m.cells.length} яч. · {m.ready ? 'готова' : 'в работе'}</div>
                  </button>
                  <HoldDeleteButton
                    onFire={() => void removeMap(m.id)}
                    label={`карту «${m.name}»`}
                    ariaLabel="Удалить карту"
                    title="Удалить карту"
                    className="px-2 text-faint hover:text-coral cursor-pointer"
                  >{Ic.cross(12)}</HoldDeleteButton>
                </div>
              ))}
              {maps.length === 0 && <div className="text-[11px] text-faint">Пока пусто — создайте первую карту</div>}
            </div>
          </div>

          {map && (
            <>
              <div>
                <div className="tick-label mb-2">{map.tileGrid ? 'Фон: карта-плитка / вся карта' : map.plateSize ? 'Фон: плитка / вся карта' : 'Общий фон карты'}</div>
                {/* КУДА ЛОЖИТСЯ НОВЫЙ ФОН — выбор появляется при разбивке на плитки ИЛИ
                    в плиточном режиме: «На эту плитку» = у каждой плитки своя картинка
                    (другая локация), «На всю карту» = одна картинка на всё поле сразу */}
                {(map.plateSize || map.tileGrid) && (
                  <>
                    <div className="flex gap-1.5 mb-1.5">
                      <button onClick={() => { setBgScope('plate'); sfx.hover(); }} title="Фон ложится ТОЛЬКО на плитку, на которую сейчас смотрит камера — у каждой плитки своя локация" className={`flex-1 py-1 border-2 cursor-pointer font-display text-[9px] uppercase ${bgScope === 'plate' ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint hover:text-dim'}`}>{map.tileGrid ? 'На эту карту-плитку' : 'На эту плитку'}</button>
                      <button onClick={() => { setBgScope('all'); sfx.hover(); }} title="Одна картинка на ВСЁ поле сразу — все плитки вместе (как раньше)" className={`flex-1 py-1 border-2 cursor-pointer font-display text-[9px] uppercase ${bgScope === 'all' ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint hover:text-dim'}`}>На всю карту</button>
                    </div>
                    {bgScope === 'plate' && (map.tileGrid ? (
                      <p className="text-[10px] text-teal leading-tight mb-1.5 border-2 border-teal/40 px-2 py-1">Сейчас редактируется <span className="text-gold">КАРТА № {activeTileNum}</span>. Другую карту — кликом по схеме в спойлере «Карты-плитки» ниже: камера перейдёт туда → загрузите её фон.</p>
                    ) : (
                      <p className="text-[10px] text-sky leading-tight mb-1.5 border-2 border-sky/40 px-2 py-1">Сейчас редактируется плитка <span className="text-gold">№ {curPlateNum}</span>. Другую плитку — кликом по номеру в навигаторе спойлера «Плитки и порталы» ниже: камера прыгнет туда → загрузите её фон.</p>
                    ))}
                  </>
                )}
                {bgIsTile ? (
                  tileBgCur ? (
                    <div className="space-y-1.5">
                      <img src={tileBgCur.bg} alt="фон карты-плитки" className="w-full border-2 border-teal/60 object-cover h-20" />
                      <div className="flex gap-1.5">
                        <GhostBtn small className="flex-1" onClick={() => { bgRef.current?.click(); }}>Заменить</GhostBtn>
                        <GhostBtn small className="flex-1" onClick={() => { setTileBg(activeTile!.id, undefined); sfx.fail(); }}>Убрать</GhostBtn>
                      </div>
                      <div className="flex gap-1.5 text-[10px]">
                        <button onClick={() => setTileBg(activeTile!.id, { ...tileBgCur, bgMode: 'stretch' })} className={`flex-1 py-1 border-2 cursor-pointer ${tileBgCur.bgMode !== 'real' ? 'border-gold text-gold' : 'border-edge text-faint'}`}>растянуть</button>
                        <button onClick={() => setTileBg(activeTile!.id, { ...tileBgCur, bgMode: 'real' })} className={`flex-1 py-1 border-2 cursor-pointer ${tileBgCur.bgMode === 'real' ? 'border-gold text-gold' : 'border-edge text-faint'}`}>1:1</button>
                      </div>
                    </div>
                  ) : (
                    <GhostBtn small className="w-full" onClick={() => { bgRef.current?.click(); }}>{Ic.plus(12)} Загрузить фон карты № {activeTileNum}</GhostBtn>
                  )
                ) : bgIsPlate ? (
                  plateBgCur ? (
                    <div className="space-y-1.5">
                      <img src={plateBgCur.bg} alt="фон плитки" className="w-full border-2 border-sky/60 object-cover h-20" />
                      <div className="flex gap-1.5">
                        <GhostBtn small className="flex-1" onClick={() => { bgRef.current?.click(); }}>Заменить</GhostBtn>
                        <GhostBtn small className="flex-1" onClick={() => { setPlateBg(curPlateNum, undefined); sfx.fail(); }}>Убрать</GhostBtn>
                      </div>
                      <div className="flex gap-1.5 text-[10px]">
                        <button onClick={() => setPlateBg(curPlateNum, { ...plateBgCur, bgMode: 'stretch' })} className={`flex-1 py-1 border-2 cursor-pointer ${plateBgCur.bgMode !== 'real' ? 'border-gold text-gold' : 'border-edge text-faint'}`}>растянуть</button>
                        <button onClick={() => setPlateBg(curPlateNum, { ...plateBgCur, bgMode: 'real' })} className={`flex-1 py-1 border-2 cursor-pointer ${plateBgCur.bgMode === 'real' ? 'border-gold text-gold' : 'border-edge text-faint'}`}>1:1</button>
                      </div>
                    </div>
                  ) : (
                    <GhostBtn small className="w-full" onClick={() => { bgRef.current?.click(); }}>{Ic.plus(12)} Загрузить фон плитки {curPlateNum}</GhostBtn>
                  )
                ) : map.bg ? (
                  <div className="space-y-1.5">
                    <img src={map.bg} alt="фон" className="w-full border-2 border-edge object-cover h-20" />
                    <div className="flex gap-1.5">
                      <GhostBtn small className="flex-1" onClick={() => { bgRef.current?.click(); }}>Заменить</GhostBtn>
                      <GhostBtn small className="flex-1" onClick={() => { updMap({ bg: undefined }); sfx.fail(); }}>Убрать</GhostBtn>
                    </div>
                    <div className="flex gap-1.5 text-[10px]">
                      <button onClick={() => updMap({ bgMode: 'stretch' })} className={`flex-1 py-1 border-2 cursor-pointer ${map.bgMode !== 'real' ? 'border-gold text-gold' : 'border-edge text-faint'}`}>растянуть</button>
                      <button onClick={() => updMap({ bgMode: 'real' })} className={`flex-1 py-1 border-2 cursor-pointer ${map.bgMode === 'real' ? 'border-gold text-gold' : 'border-edge text-faint'}`}>1:1</button>
                    </div>
                  </div>
                ) : (
                  <GhostBtn small className="w-full" onClick={() => { bgRef.current?.click(); }}>{Ic.plus(12)} Загрузить фон (картинку)</GhostBtn>
                )}
                <p className="text-[10px] text-faint mt-1 leading-tight">
                  {(bgIsPlate || bgIsTile)
                    ? 'Свой фон ложится ТОЛЬКО на выбранную плитку — соседние не тронуты: каждой плитке можно дать свою «локацию». Одна картинка на всё поле — переключатель «На всю карту» выше. '
                    : ''}
                  Фон лежит ВНУТРИ карты и уедет игрокам сам. Большая картинка сожмётся до 2000px.
                </p>
              </div>

              {/* СЛОИ: фон — самый низ, тайловые слои (выбор + добавление), ячейки и стрелки — всегда самый верх */}
              {map && (
                <div>
                  <button onClick={() => setLayersOpen((o) => !o)} className="w-full flex items-center gap-1.5 mb-2 cursor-pointer group" title={layersOpen ? 'Свернуть' : 'Развернуть'}>
                    <span className={`text-[10px] ${layersOpen ? 'text-gold' : 'text-faint'}`}>{layersOpen ? '▾' : '▸'}</span>
                    <span className="tick-label group-hover:text-paper">🗂 Слои карты</span>
                  </button>
                  {layersOpen && (
                    <div className="space-y-1">
                      {/* фон — самый нижний слой */}
                      <div className="flex items-center gap-1.5 border-2 border-edge bg-panel px-2 py-1.5">
                        <span className="text-[10px] shrink-0">🖼</span>
                        <span className="font-display text-[10px] uppercase text-dim flex-1 min-w-0 truncate">Фон</span>
                        <span className="tick-label text-faint">{map.bg ? 'есть' : 'нет'}{plateBgCount > 0 ? ` + плиток: ${plateBgCount}` : ''} · низ</span>
                      </div>
                      {/* тайловые слои: клик — выбрать для рисования, крестик — удалить слой (кроме последнего) */}
                      {Array.from({ length: map.tileLayers ?? 2 }, (_, i) => i).map((i) => {
                        const cnt = (map.stamps ?? []).filter((s) => (s.layer ?? 0) === i).length;
                        const active = activeLayer === i;
                        const canDel = (map.tileLayers ?? 2) > 1; // минимум один тайловый слой остаётся всегда
                        return (
                          <div
                            key={i}
                            className={`w-full flex items-center gap-0.5 border-2 px-2 py-1.5 transition-colors ${active ? 'border-gold bg-gold/10' : 'border-edge bg-panel hover:border-edge2'}`}
                          >
                            <button
                              onClick={() => { setActiveLayer(i); sfx.hover(); }}
                              className="flex-1 min-w-0 flex items-center gap-1.5 cursor-pointer text-left"
                              title={active ? 'Активный слой — новые тайлы встанут сюда' : `Рисовать на слое ${i + 1}`}
                            >
                              <span className={`text-[10px] shrink-0 ${active ? 'text-gold' : 'text-faint'}`}>{active ? '✏' : '·'}</span>
                              <span className={`font-display text-[10px] uppercase flex-1 min-w-0 text-left truncate ${active ? 'text-gold' : 'text-dim'}`}>Слой {i + 1}</span>
                              <span className="tick-label text-faint">{cnt} шт.</span>
                            </button>
                            {canDel && (
                              <HoldDeleteButton
                                onFire={() => deleteLayerNow(i)}
                                label={`слой ${i + 1}${cnt ? ` (тайлов: ${cnt})` : ' (пустой)'}`}
                                ariaLabel="Удалить слой"
                                title="Удалить слой вместе с тайлами на нём"
                                className="text-faint hover:text-coral cursor-pointer shrink-0 px-0.5"
                              >{Ic.cross(10)}</HoldDeleteButton>
                            )}
                          </div>
                        );
                      })}
                      {/* ячейки и стрелки — всегда самый верх */}
                      <div className="flex items-center gap-1.5 border-2 border-edge bg-panel px-2 py-1.5">
                        <span className="text-[10px] shrink-0">✚</span>
                        <span className="font-display text-[10px] uppercase text-dim flex-1 min-w-0 truncate">Ячейки и стрелки</span>
                        <span className="tick-label text-faint">всегда верх</span>
                      </div>
                      <div className="flex items-center justify-between pt-0.5">
                        <p className="text-[10px] text-faint leading-tight flex-1 min-w-0">Активный слой помечен ✏ — новые тайлы встанут на него. «Слой ±» в панели тайла переносит его между слоями. Крестик справа удаляет слой вместе с его тайлами (последний слой не удаляется) — Ctrl+Z вернёт.</p>
                        {(map.tileLayers ?? 2) < 6 && (
                          <GhostBtn small className="ml-2 shrink-0" onClick={() => {
                            const n = (map.tileLayers ?? 2) + 1;
                            updMap({ tileLayers: n });
                            setActiveLayer(n - 1); // новый слой сразу активен — рисуем на нём
                            dirtyRef.current = true;
                            sfx.coin();
                          }}>{Ic.plus(11)} Слой</GhostBtn>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="tick-label">Тайлы карты · {tileset.length}</div>
                  <button onClick={() => { filesRef.current?.click(); }} className="text-[10px] text-sky hover:text-paper cursor-pointer">+ файлы</button>
                </div>
                <div className="flex gap-1.5 mb-2">
                  <GhostBtn small className="flex-1" onClick={() => { folderRef.current?.click(); }}>{Ic.upload(12)} Папка</GhostBtn>
                  <GhostBtn small className="flex-1" onClick={() => { extRef.current?.click(); }}>✂ Нарезать</GhostBtn>
                </div>
                {/* палитра: спойлеры-группы (папки, файлы, вырезки) */}
                {(map.tileGroups ?? []).map((g) => {
                  const inG = g.tids.map((tid) => tileImgById.get(tid)).filter(Boolean) as TileImg[];
                  const tag = g.kind === 'extract' ? '✂' : g.kind === 'folder' ? '›' : '+';
                  return (
                    <div key={g.id} className="mb-2">
                      <div className="flex items-center gap-1 mb-1">
                        <button
                          onClick={() => toggleGroup(g.id)}
                          className="flex-1 min-w-0 flex items-center gap-1 text-left cursor-pointer hover:bg-[rgba(90,169,255,0.08)] px-1 py-0.5"
                          title={g.collapsed ? 'Развернуть' : 'Свернуть'}
                        >
                          <span className={`text-[10px] shrink-0 ${g.collapsed ? 'text-faint' : 'text-gold'}`}>{g.collapsed ? '▸' : '▾'}</span>
                          <span className="text-[10px] text-faint shrink-0">{tag}</span>
                          <span className="font-display text-[10px] uppercase text-dim truncate">{g.name}</span>
                          <span className="tick-label text-faint shrink-0">· {inG.length}</span>
                        </button>
                        <HoldDeleteButton
                          onFire={() => delGroup(g)}
                          label={g.name}
                          ariaLabel="Убрать группу"
                          title="Убрать группу из панели (папку на компьютере это не трогает)"
                          className="text-faint hover:text-coral cursor-pointer shrink-0 px-0.5"
                        >{Ic.cross(10)}</HoldDeleteButton>
                      </div>
                      {!g.collapsed && (
                        <div className="grid grid-cols-4 gap-1.5">
                          {inG.map((t) => (
                            <button
                              key={t.id}
                              title={t.name}
                              onClick={() => { setTileId(t.id); setTool('tile'); sfx.hover(); }}
                              className={`relative aspect-square border-2 overflow-hidden cursor-pointer transition-transform hover:scale-105 ${tileId === t.id ? 'border-gold' : 'border-edge'}`}
                            >
                              <img src={t.dataUrl} alt={t.name} className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
                              <HoldDeleteButton
                                as="span"
                                onFire={() => delTile(t.id)}
                                label={t.name}
                                ariaLabel="удалить тайл"
                                title="Удалить тайл"
                                className={`absolute top-0 right-0 w-4 h-4 bg-coral text-abyss font-pixel text-[8px] flex items-center justify-center cursor-pointer ${tileId === t.id ? 'opacity-90' : 'opacity-0 hover:opacity-100'}`}
                              >×</HoldDeleteButton>
                              {/* +/− размера — ОДНИ правила с крестиком удаления (delGuard) */}
                              <TileSizeBtns name={t.name} onSize={(dir) => void resizePalTile(t, dir)} />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {(map.tileGroups ?? []).length === 0 && (
                  <p className="text-[10px] text-faint leading-tight">Загрузите папку с картинками-тайлами, отдельные файлы или нарежьте тайлы из большой картинки («✂ Нарезать»). Каждая группа — спойлер: сворачивается кликом по названию.</p>
                )}
              </div>

              <div>
                <div className="tick-label mb-2">{map.tileGrid ? 'Карты-плитки' : map.plateSize ? 'Поле = плитки' : 'Размер поля (px)'}</div>
                {!map.plateSize && !map.tileGrid && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {SIZE_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        onClick={() => { updMap({ mw: p.w, mh: p.h }); sfx.hover(); }}
                        className={`px-2 py-1 text-[9px] font-pixel border-2 cursor-pointer ${msz.w === p.w && msz.h === p.h ? 'border-gold text-gold' : 'border-edge text-faint hover:text-dim'}`}
                      >{p.label}</button>
                    ))}
                  </div>
                )}
                <div className="space-y-2">
                  {map.tileGrid ? (
                    <>
                      <p className="text-[10px] text-teal leading-tight border-2 border-teal/40 px-2 py-1.5">
                        Плиточный режим: {map.tileGrid.tiles.length} карт-плиток по {map.tileGrid.w}×{map.tileGrid.h} px — у каждой своя локация.
                        Схема и добавление плиток — в спойлере «Карты-плитки» ниже.
                      </p>
                      <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Ширина плитки</span><Stepper value={map.tileGrid.w} onChange={(v) => resizeTileGrid('w', v)} min={640} max={MAX_FIELD} step={160} /></div>
                      <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Высота плитки</span><Stepper value={map.tileGrid.h} onChange={(v) => resizeTileGrid('h', v)} min={640} max={MAX_FIELD} step={160} /></div>
                    </>
                  ) : map.plateSize ? (
                    <p className="text-[10px] text-dim leading-tight border-2 border-sky/40 px-2 py-1.5">
                      Поле {msz.w}×{msz.h} px = {platesX}×{platesY} плиток по {map.plateSize} px{plateBgCount > 0 ? ` · своих фонов: ${plateBgCount}` : ''}.
                      Размер и навигатор плиток — в спойлере «Плитки и порталы» ниже.
                    </p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Ширина</span><Stepper value={msz.w} onChange={(v) => resizeField('mw', v)} min={640} max={MAX_FIELD} step={160} /></div>
                      <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Высота</span><Stepper value={msz.h} onChange={(v) => resizeField('mh', v)} min={640} max={MAX_FIELD} step={160} /></div>
                    </>
                  )}
                </div>
              </div>

              <div>
                <div className="tick-label mb-2">Ресурс игроков — ВЫБОР ОДНОГО</div>
                {(map.mode ?? 'classic') === 'skill' ? (
                  /* SKILL CHALLENGE: ресурсы фиксированы условием челленджа — менять нельзя */
                  <div className="space-y-2">
                    <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Минут у каждого</span><span className="font-display text-sm text-gold">60</span></div>
                    <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Попыток у каждого</span><span className="font-display text-sm text-gold">60</span></div>
                    <p className="text-[10px] text-magma leading-tight border-2 border-magma/40 px-2 py-1.5">Условие челленджа: у каждого ровно 60 минут и 60 попыток — менять нельзя.</p>
                  </div>
                ) : (map.mode ?? 'classic') === 'rubg' ? (
                  /* RUBG: ресурс ВСЕГДА полоска HP — выбор заблокирован */
                  <div className="space-y-2">
                    <div className="border-2 border-coral/60 bg-coral/10 px-3 py-2.5">
                      <div className="font-display uppercase text-[12px] text-coral">❤ Полоска HP</div>
                      <div className="text-[10px] text-dim mt-1 leading-tight">В RUBG ресурс всегда ПОЛОСКА HP: победа в задании +10%, поражение −5%; вне зоны HP тает каждый секунду. Выбор заблокирован.</div>
                    </div>
                    <p className="text-[9px] text-faint leading-tight">Монеты/время/попытки в RUBG не используются — в игре показывается только полоска HP.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* ТРИ взаимоисключающих варианта — как в мастере «Создать челлендж» */}
                    {([
                      { id: 'std', title: '⏱ 🎯 Время и попытки', desc: 'Классика: таймер и попытки у каждого. Кнопки «Время/Попытки» в окне задания.' },
                      { id: 'coins', title: '🪙 Монеты', desc: 'Единственный ресурс — монеты (старт/награды/плата за пропуск). 0 монет = вылет.' },
                      { id: 'hp', title: '❤ Полоска HP', desc: 'Единственный ресурс — HP: победа +10%, поражение/пропуск −5%. На нуле — вылет.' },
                    ] as const).map((r) => {
                      const on = (map.resMode ?? (map.coinsOnly && map.startCoins !== undefined ? 'coins' : 'std')) === r.id;
                      return (
                        <button
                          key={r.id}
                          onClick={() => {
                            sfx.hover();
                            if (r.id === 'coins') {
                              updMap({ resMode: 'coins', coinsOnly: true, startCoins: map.startCoins ?? 100, taskWinCoins: map.taskWinCoins ?? 10, skipCoins: map.skipCoins ?? 5, quizWinCoins: map.quizWinCoins ?? 5, quizLoseCoins: map.quizLoseCoins ?? 5 });
                            } else if (r.id === 'hp') {
                              updMap({ resMode: 'hp', coinsOnly: undefined, startCoins: undefined });
                            } else {
                              updMap({ resMode: 'std', coinsOnly: undefined, startCoins: undefined });
                            }
                          }}
                          className={`w-full text-left px-3 py-2 border-2 transition-colors cursor-pointer ${on ? 'border-gold bg-gold/10' : 'border-edge hover:border-edge2'}`}
                        >
                          <div className={`font-display uppercase text-[12px] ${on ? 'text-gold' : 'text-paper'}`}>{on ? '✓ ' : ''}{r.title}</div>
                          <div className="text-[10px] text-dim mt-0.5 leading-tight">{r.desc}</div>
                        </button>
                      );
                    })}
                    {/* настройки выбранного варианта */}
                    {(map.resMode ?? 'std') === 'std' && (
                      <div className="space-y-2 pt-1">
                        <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Минут у каждого</span><Stepper value={map.startMin ?? 60} onChange={(v) => updMap({ startMin: v })} min={5} max={180} step={5} /></div>
                        <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Попыток у каждого</span><Stepper value={map.startTries ?? 60} onChange={(v) => updMap({ startTries: v })} min={5} max={180} step={5} /></div>
                      </div>
                    )}
                    {map.resMode === 'coins' && (
                      <div className="space-y-2 pt-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-dim">Стартовый капитал</span>
                          <Stepper value={map.startCoins ?? 100} onChange={(v) => updMap({ startCoins: v })} min={0} max={99999} step={25} suffix=" бр" />
                        </div>
                        <div className="text-[9px] text-faint leading-tight">{coinsStr(map.startCoins ?? 100)} · 100 бронзы = 1 серебряная, 100 серебр. = 1 золотая, 100 зол. = 1 платиновая</div>
                        <div className="flex items-center justify-between"><span className="text-[11px] text-dim">+ за победу в задании</span><Stepper value={map.taskWinCoins ?? 10} onChange={(v) => updMap({ taskWinCoins: v })} min={0} max={9999} step={5} suffix=" бр" /></div>
                        <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Цена пропуска задания</span><Stepper value={map.skipCoins ?? 5} onChange={(v) => updMap({ skipCoins: v })} min={0} max={9999} step={5} suffix=" бр" /></div>
                        <div className="flex items-center justify-between"><span className="text-[11px] text-dim">+ за верный ответ квиза</span><Stepper value={map.quizWinCoins ?? 5} onChange={(v) => updMap({ quizWinCoins: v })} min={0} max={9999} step={5} suffix=" бр" /></div>
                        <div className="flex items-center justify-between"><span className="text-[11px] text-dim">− за неверный ответ квиза</span><Stepper value={map.quizLoseCoins ?? 5} onChange={(v) => updMap({ quizLoseCoins: v })} min={0} max={9999} step={5} suffix=" бр" /></div>
                        <p className="text-[9px] text-faint leading-tight">Пропуск 0 бр = бесплатный. В монетном режиме перезапуски задания бесплатны. Квизы платят бронзой.</p>
                      </div>
                    )}
                    {map.resMode === 'hp' && (
                      <p className="text-[9px] text-faint leading-tight">Победа в задании +10% HP, поражение/пропуск −5% HP, перезапуски бесплатны. На нуле полоски — вылет. В игре показывается только полоска HP.</p>
                    )}
                  </div>
                )}
              </div>

              {/* RUBG: БЕЗОПАСНАЯ ЗОНА — ПОДРОБНАЯ настройка: полное время + КАЖДАЯ ФАЗА
                  (своя пауза, длительность сжатия и сужение радиуса в КЛЕТКАХ) */}
              {(map.mode ?? 'classic') === 'rubg' && (() => {
                const CPX = 64; // px в клетке поля
                const mwL = map.mw ?? map.cols * CPX, mhL = map.mh ?? map.rows * CPX;
                const r0L = Math.hypot(mwL, mhL) / 2 * 0.75;
                const scaleL = Math.max(30, Math.floor(map.zoneSec ?? 600)) / RUBG_ZONE_TOTAL;
                /* эффективные фазы: авторские (zonePhases) или дефолт (масштаб zoneSec),
                   пересчитанные в КЛЕТКИ для показа */
                let rrL = r0L;
                const eff: { wait: number; shrink: number; dist: number }[] = map.zonePhases?.length
                  ? map.zonePhases.map((p) => ({ wait: Math.max(0, Math.floor(p.wait || 0)), shrink: Math.max(5, Math.floor(p.shrink || 0)), dist: Math.max(0, Math.floor(p.dist || 0)) }))
                  : RUBG_ZONE_PHASES.map((p) => {
                      const nr = rrL * p.mul;
                      const d = Math.max(0, Math.round((rrL - nr) / CPX));
                      rrL = nr;
                      return { wait: Math.round(p.wait * scaleL), shrink: Math.round(p.shrink * scaleL), dist: d };
                    });
                const totalL = eff.reduce((a, p) => a + p.wait + p.shrink, 0);
                const setPhases = (ph: { wait: number; shrink: number; dist: number }[]) => updMap({ zonePhases: ph });
                const rescale = (nt: number) => {
                  const k = Math.max(30, nt) / Math.max(1, totalL);
                  setPhases(eff.map((p) => ({ wait: Math.max(0, Math.round(p.wait * k)), shrink: Math.max(5, Math.round(p.shrink * k)), dist: p.dist })));
                };
                return (
                  <div>
                    <div className="tick-label mb-2">⭕ Безопасная зона · RUBG</div>
                    <div className="space-y-2">
                      {/* Полное время: пересчитывает ВСЕ фазы пропорционально */}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-dim shrink-0">Полное время зоны</span>
                        <div className="flex items-center gap-1">
                          <Stepper value={Math.min(180, Math.floor(totalL / 60))} onChange={(m) => rescale(m * 60 + (totalL % 60))} min={0} max={180} suffix=" мин" />
                          <Stepper value={totalL % 60} onChange={(sc) => rescale(Math.floor(totalL / 60) * 60 + sc)} min={0} max={55} step={5} suffix=" с" />
                        </div>
                      </div>
                      <p className="text-[9px] text-faint leading-tight">
                        Меняет время сразу для всех фаз (пропорционально). Ниже — ПОДРОБНАЯ настройка: у каждой фазы СВОЯ пауза, длительность сжатия и сужение в клетках. Урон вне зоны нарастает по фазам сам: {RUBG_ZONE_PHASES.map((p) => p.dps).join(' → ')} %/с.
                      </p>
                      {/* ФАЗЫ: пауза / сжатие / сужение каждой */}
                      <div className="space-y-1.5">
                        {eff.map((p, i) => {
                          const dps = RUBG_ZONE_PHASES[Math.min(i, RUBG_ZONE_PHASES.length - 1)].dps;
                          const upd = (patch: Partial<{ wait: number; shrink: number; dist: number }>) => {
                            setPhases(eff.map((q, j) => (j === i ? { ...q, ...patch } : q)));
                          };
                          return (
                            <div key={i} className="border-2 border-edge px-2 py-1.5 space-y-1">
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="font-display uppercase text-paper">Фаза {i + 1}</span>
                                <span className="font-pixel text-[8px] text-coral" title="Урон вне зоны в эту фазу">вне зоны −{dps}%/с</span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-dim shrink-0">Пауза до сжатия</span>
                                <div className="flex items-center gap-1">
                                  <Stepper value={Math.min(180, Math.floor(p.wait / 60))} onChange={(m) => upd({ wait: m * 60 + (p.wait % 60) })} min={0} max={180} suffix=" мин" />
                                  <Stepper value={p.wait % 60} onChange={(sc) => upd({ wait: Math.floor(p.wait / 60) * 60 + sc })} min={0} max={55} step={5} suffix=" с" />
                                </div>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-dim shrink-0">Длительность сжатия</span>
                                <Stepper value={Math.min(180, p.shrink)} onChange={(v) => upd({ shrink: v })} min={5} max={180} step={5} suffix=" с" />
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-dim shrink-0">Сужение радиуса</span>
                                <Stepper value={Math.min(60, p.dist)} onChange={(v) => upd({ dist: v })} min={0} max={60} suffix=" кл" />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[9px] text-faint leading-tight">
                        Итог: {rubgFmtZone(totalL)}. «Сужение» — на сколько КЛЕТОК уменьшится радиус в этой фазе (для большой карты шаг в 3–6 кл заметен; фаза с сужением по всему радиусу закроет карту целиком). Минимум полного времени — 30 с.
                      </p>
                    </div>
                  </div>
                );
              })()}

              <div>
                <div className="tick-label mb-2">Режим игры</div>
                <div className="space-y-1.5">
                  {MAP_MODES.map((md) => {
                    const on = (map.mode ?? 'classic') === md.id;
                    return (
                      <button
                        key={md.id}
                        onClick={() => {
                          sfx.hover();
                          /* RUBG: ресурс всегда «Полоска HP» — при включении режима монеты выключаются */
                          if (md.id === 'rubg') updMap({ mode: md.id, resMode: 'hp', coinsOnly: undefined, startCoins: undefined });
                          else updMap({ mode: md.id });
                        }}
                        title={md.hint}
                        className={`w-full text-left border-2 px-2.5 py-2 cursor-pointer transition-colors ${on ? 'border-gold bg-gold/10' : 'border-edge bg-panel hover:border-edge2'}`}
                      >
                        <div className={`font-display text-[11px] uppercase ${on ? 'text-gold' : 'text-paper'}`}>{on ? '✓ ' : ''}{md.name}</div>
                      </button>
                    );
                  })}
                </div>
                {/* СВОИ ЧЕЛЛЕНДЖИ (мастер «Создать челлендж» с главного экрана): */}
                {challenges.length > 0 && (
                  <div className="mt-2">
                    <div className="tick-label mb-1.5 text-[#ff8b3f]">Мои челленджи · {challenges.length}</div>
                    <div className="space-y-1.5">
                      {challenges.map((cc: CustomChallenge) => {
                        const on = map.customId === cc.id;
                        return (
                          <div key={cc.id} className="flex items-stretch gap-1">
                            <button
                              onClick={() => { applyChallenge(cc); sfx.coin(); }}
                              title={`Применить к карте: ${challengeSummaryLines(cc.answers).join(' · ')}`}
                              className={`min-w-0 flex-1 text-left border-2 px-2.5 py-2 cursor-pointer transition-colors ${on ? 'border-[#ff8b3f] bg-[#ff8b3f]/10' : 'border-edge bg-panel hover:border-edge2'}`}
                            >
                              <div className={`font-display text-[11px] uppercase ${on ? 'text-[#ff8b3f]' : 'text-paper'}`}>{on ? '✓ ' : ''}{cc.name}</div>
                              <div className="text-[9px] text-faint mt-0.5">{cc.resolved.mapless ? 'без карты (старый формат v0.36.0)' : `свой режим · ${MAP_MODES.find((x) => x.id === cc.resolved.baseMode)?.name ?? cc.resolved.baseMode}`}</div>
                            </button>
                            <HoldDeleteButton
                              onFire={() => { void (async () => { await idbDel('challenges', cc.id); await refresh(); sfx.fail(); toast(`Челлендж «${cc.name}» удалён`, 'ok'); })(); }}
                              label={`челлендж «${cc.name}»`}
                              className="shrink-0 w-7 flex items-center justify-center border-2 border-edge text-faint hover:text-coral hover:border-coral/60 cursor-pointer"
                            >{Ic.cross(10)}</HoldDeleteButton>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {map.customId && (
                  <div className="mt-2 border-2 border-[#ff8b3f]/60 px-2 py-1.5 flex items-center gap-2">
                    <span className="text-[10px] text-[#ff8b3f] leading-tight flex-1">СВОЙ РЕЖИМ: {map.customName ?? 'челлендж'}. Штрафы/награды уже работают в игре.</span>
                    <button
                      onClick={() => { updMap({ customId: undefined, customName: undefined, loseMin: undefined, loseTries: undefined, winMin: undefined, winTries: undefined }); sfx.fail(); }}
                      title="Снять свой режим с карты (настройки карты останутся)"
                      className="text-faint hover:text-coral cursor-pointer shrink-0 text-[12px] leading-none px-1"
                    >×</button>
                  </div>
                )}
                {/* описания челленджей — под спойлером, чтобы не занимали панель всегда */}
                <button
                  onClick={() => setModeDescOpen((v) => !v)}
                  className="flex items-center gap-1 w-full text-left mt-2 px-1 py-0.5 cursor-pointer hover:bg-[rgba(90,169,255,0.08)]"
                  title={modeDescOpen ? 'Свернуть' : 'Развернуть'}
                >
                  <span className={`text-[10px] shrink-0 ${modeDescOpen ? 'text-gold' : 'text-faint'}`}>{modeDescOpen ? '▾' : '▸'}</span>
                  <span className="tick-label text-faint">Описания режимов</span>
                </button>
                {modeDescOpen && (
                  <div className="space-y-1.5 mt-1.5 border-2 border-edge px-2 py-2">
                    {MAP_MODES.map((md) => (
                      <p key={md.id} className="text-[10px] text-faint leading-tight"><span className="text-dim font-display uppercase">{md.name}</span> — {md.hint}</p>
                    ))}
                    <p className="text-[10px] text-faint leading-tight">
                      Отметка действует на ВСЮ карту и видна игрокам при выборе карты. RETROPOLIA — обычная игра с кубиками (по умолчанию).
                    </p>
                  </div>
                )}
              </div>

              <div>
                <button
                  onClick={() => setWallsOpen((v) => !v)}
                  className="flex items-center gap-1 w-full text-left mb-2 cursor-pointer hover:bg-[rgba(90,169,255,0.08)] px-1 py-0.5"
                  title={wallsOpen ? 'Свернуть' : 'Развернуть'}
                >
                  <span className={`text-[10px] shrink-0 ${wallsOpen ? 'text-gold' : 'text-faint'}`}>{wallsOpen ? '▾' : '▸'}</span>
                  <span className="tick-label">Невидимые стены · {(map.walls ?? []).length}</span>
                </button>
                {wallsOpen && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] text-faint leading-tight">Зоны, куда фишка НЕ может зайти («невидимые стены» в играх). Ходить изначально можно ВЕЗДЕ — стены только исключения. Инструмент «Стена»: протяните прямоугольник по полю. В игре стены не рисуются.</p>
                    <p className={`text-[10px] leading-tight border-2 px-2 py-1.5 ${isJourneyLike(map.mode) ? 'text-teal border-teal/40' : 'text-magma border-magma/40'}`}>
                      {isJourneyLike(map.mode)
                        ? `Режим ${map.mode === 'journey1p' ? 'JOURNEY' : 'TRIATHLON'} — стены активны: фишки не смогут их пересечь.`
                        : 'Стены работают ТОЛЬКО в TRIATHLON и JOURNEY: с любым другим режимом карту не завершить — смените режим или удалите все стены.'}
                    </p>
                    {(map.walls ?? []).length > 0 && (
                      <>
                        <p className="text-[10px] text-dim leading-tight">Клик по стене — выбрать и тянуть, Delete — удалить выбранную. Можно убрать все стены одной кнопкой:</p>
                        <PxBtn color="coral" small className="w-full" onClick={removeAllWalls}>{Ic.trash(12)} Удалить все стены разом</PxBtn>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* ПЛИТОЧНЫЙ РЕЖИМ КАРТ: схема плиток-локаций, добавление/выбор/удаление */}
              <div>
                <button
                  onClick={() => setTilesOpen((v) => !v)}
                  className="flex items-center gap-1 w-full text-left mb-2 cursor-pointer hover:bg-[rgba(90,169,255,0.08)] px-1 py-0.5"
                  title={tilesOpen ? 'Свернуть' : 'Развернуть'}
                >
                  <span className={`text-[10px] shrink-0 ${tilesOpen ? 'text-gold' : 'text-faint'}`}>{tilesOpen ? '▾' : '▸'}</span>
                  <span className="tick-label">Карты-плитки{map.tileGrid ? ` · ${map.tileGrid.tiles.length}` : ''}{tileBgCount > 0 ? ` · фонов: ${tileBgCount}` : ''}</span>
                </button>
                {tilesOpen && (
                  <div className="space-y-2">
                    {!map.tileGrid ? (
                      <>
                        <p className="text-[10px] text-faint leading-tight">ПЛИТОЧНЫЙ РЕЖИМ — мир из нескольких ОТДЕЛЬНЫХ карт-локаций одного размера: сейчас редактируете одну карту, игрок через ПОРТАЛ попадает на другую (соседнюю или любую далёкую). Бесконечное увеличение поля (панель «Размер поля») тоже остаётся доступным.</p>
                        <PxBtn color="teal" small className="w-full" onClick={enableTileMode}>{Ic.grid(12)} Включить плиточный режим</PxBtn>
                        <p className="text-[10px] text-faint leading-tight">Текущее поле станет картой №1 — всё нарисованное останется на ней.</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[10px] text-teal leading-tight border-2 border-teal/40 px-2 py-1.5">Плиточный режим ВКЛЮЧЁН: каждая плитка — отдельная карта-локация {map.tileGrid.w}×{map.tileGrid.h} px. В ИГРЕ фишка зажата в своей карте, на другие — только через порталы.</p>
                        {/* СХЕМА ПЛИТОК: клик — перейти на карту (камера + её фон), крестик — удалить */}
                        <div>
                          <div className="tick-label mb-1">Схема плиток (клик — перейти на карту)</div>
                          <div
                            className="grid gap-1"
                            style={{ gridTemplateColumns: `repeat(${Math.min(tgCols, 8)}, minmax(0, 1fr))` }}
                          >
                            {Array.from({ length: tgCols * tgRows }, (_, i) => {
                              const col = i % tgCols, row = Math.floor(i / tgCols);
                              const t = map.tileGrid!.tiles.find((x) => x.col === col && x.row === row);
                              const idx = t ? map.tileGrid!.tiles.indexOf(t) : -1;
                              if (!t) return <div key={i} className="aspect-square border-2 border-dashed border-edge/50" title="Свободный слот схемы" />;
                              const isActive = activeTile?.id === t.id;
                              const hasBg = !!(map.tileBgs ?? {})[t.id];
                              return (
                                <div key={i} className="relative">
                                  <button
                                    onClick={() => selectTile(t)}
                                    title={`КАРТА ${idx + 1}: клик — редактировать эту локацию${hasBg ? ' · свой фон есть' : ''}`}
                                    className={`relative w-full aspect-square border-2 cursor-pointer font-pixel text-[9px] ${isActive ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint hover:text-dim hover:border-edge2'}`}
                                  >
                                    {idx + 1}
                                    {hasBg && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-teal pointer-events-none" title="У этой карты свой фон" />}
                                  </button>
                                  {map.tileGrid!.tiles.length > 1 && (
                                    <HoldDeleteButton
                                      as="span"
                                      onFire={() => removeMapTile(t.id)}
                                      label={`карту-плитку №${idx + 1}`}
                                      ariaLabel={`Удалить карту-плитку ${idx + 1}`}
                                      title={`Удалить карту-плитку ${idx + 1} вместе с её содержимым`}
                                      className={`absolute -top-1.5 -right-1.5 w-4 h-4 bg-coral text-abyss font-pixel text-[8px] flex items-center justify-center cursor-pointer ${isActive ? 'opacity-90' : 'opacity-70 hover:opacity-100'}`}
                                    >×</HoldDeleteButton>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {tileBgCount > 0 && <p className="text-[9px] text-teal mt-1 leading-tight"><span className="inline-block w-1.5 h-1.5 bg-teal align-middle mr-0.5" /> — у карты свой фон ({tileBgCount} шт., загрузка в панели «Фон» выше)</p>}
                        </div>
                        <PxBtn color="teal" small className="w-full" onClick={addMapTile}>{Ic.plus(12)} Добавить карту-плитку</PxBtn>
                        <p className="text-[10px] text-faint leading-tight">Новая плитка встаёт рядом с выбранной. Порталы (инструмент «Портал») связывают ЛЮБЫЕ плитки — соседние и далёкие: протяните зону входа на одной плитке, переключитесь на другую и кликните — точка перехода.</p>
                        <PxBtn color="coral" small className="w-full" onClick={disableTileMode}>Выключить плиточный режим</PxBtn>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div>
                <button
                  onClick={() => setPlatesOpen((v) => !v)}
                  className="flex items-center gap-1 w-full text-left mb-2 cursor-pointer hover:bg-[rgba(90,169,255,0.08)] px-1 py-0.5"
                  title={platesOpen ? 'Свернуть' : 'Развернуть'}
                >
                  <span className={`text-[10px] shrink-0 ${platesOpen ? 'text-gold' : 'text-faint'}`}>{platesOpen ? '▾' : '▸'}</span>
                  <span className="tick-label">Плитки и порталы · {(map.portals ?? []).length}{map.plateSize ? ` · ${platesX}×${platesY}` : ''}</span>
                </button>
                {platesOpen && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] text-faint leading-tight">Два способа сделать карту БОЛЬШОЙ: 1) просто увеличьте «Размер поля» выше; 2) ПЛИТКИ — страницы поля одинакового размера: СОСЕДНИЕ плитки стыкуются краями (фишка переходит ходьбой в любом месте стыка), ЛЮБЫЕ плитки связываются порталами-телепортами. У каждой плитки — СВОЙ ФОН («другая локация»): навигатором прыгните на плитку и загрузите фон в панели «Фон» выше (переключатель «На эту плитку / На всю карту»).</p>
                    {!map.plateSize ? (
                      <PxBtn color="sky" small className="w-full" onClick={enablePlates}>{Ic.grid(12)} Разбить поле на плитки</PxBtn>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-dim">Сторона плитки</span>
                          <div className="flex gap-1">
                            {PLATE_SIZES.map((ps) => (
                              <button
                                key={ps}
                                onClick={() => { applyPlates(ps, Math.max(1, Math.ceil(msz.w / ps)), Math.max(1, Math.ceil(msz.h / ps))); sfx.hover(); }}
                                className={`px-2 py-1 text-[9px] font-pixel border-2 cursor-pointer ${map.plateSize === ps ? 'border-gold text-gold' : 'border-edge text-faint hover:text-dim'}`}
                              >{ps}</button>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Плиток по X</span><Stepper value={platesX} onChange={(v) => applyPlates(map.plateSize!, v, platesY)} min={1} max={plateCountMax} step={1} /></div>
                        <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Плиток по Y</span><Stepper value={platesY} onChange={(v) => applyPlates(map.plateSize!, platesX, v)} min={1} max={plateCountMax} step={1} /></div>
                        <div>
                          <div className="tick-label mb-1">Переход к плитке (клик — камера туда)</div>
                          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(platesX, 8)}, minmax(0, 1fr))` }}>
                            {Array.from({ length: Math.min(platesX * platesY, 64) }, (_, i) => {
                              const col = i % platesX, row = Math.floor(i / platesX);
                              const hasOwnBg = !!(map.plateBgs ?? {})[i + 1];
                              return (
                                <button
                                  key={i}
                                  onClick={() => jumpToPlate(col, row)}
                                  className={`relative py-1 text-[9px] font-pixel border-2 cursor-pointer ${curPlateIdx === i ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint hover:text-dim'}`}
                                >{i + 1}
                                  {hasOwnBg && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-sky pointer-events-none" title="У этой плитки свой фон" />}
                                </button>
                              );
                            })}
                          </div>
                          {plateBgCount > 0 && <p className="text-[9px] text-sky mt-1 leading-tight"><span className="inline-block w-1.5 h-1.5 bg-sky align-middle mr-0.5" /> — у плитки свой фон ({plateBgCount} шт.)</p>}
                        </div>
                        <PxBtn color="coral" small className="w-full" onClick={disablePlates}>Убрать разбивку (одно поле)</PxBtn>
                      </>
                    )}
                    <p className="text-[10px] text-faint leading-tight border-t-2 border-edge pt-1.5">ПОРТАЛ (инструмент «Портал»): протяните зону входа, затем кликните по карте — куда переносить (плитку переключите навигатором выше). Фишка войдёт в зону — мгновенный перенос. Работает в JOURNEY при свободном хождении; в CLASSIC/SKILL связывайте плитки стрелками «Переход» между ячейками — их прыжок достаёт до любой плитки. Клик по порталу — выбрать/тянуть, Delete — удалить.</p>
                    {selPortal !== null && (map.portals ?? [])[selPortal] && (
                      <div className="border-2 border-gold/50 px-2 py-1.5 space-y-1.5">
                        <div className="text-[10px] text-gold font-display uppercase">Портал {selPortal + 1}{(map.portals![selPortal].tx !== undefined ? ` → плитка ${plateNumOf(map.portals![selPortal].tx!, map.portals![selPortal].ty!)}` : ' — без точки перехода')}</div>
                        <PxBtn color="sky" small className="w-full" onClick={() => { setPickTargetFor(selPortal); sfx.click(); }}>Указать точку перехода заново</PxBtn>
                        <PxBtn color="coral" small className="w-full" onClick={() => removePortal(selPortal)}>{Ic.trash(12)} Удалить портал</PxBtn>
                      </div>
                    )}
                    {(map.portals ?? []).length > 0 && (
                      <PxBtn color="coral" small className="w-full" onClick={removeAllPortals}>{Ic.trash(12)} Удалить все порталы разом</PxBtn>
                    )}
                  </div>
                )}
              </div>

              <div>
                <button
                  onClick={() => setTokOpen((v) => !v)}
                  className="flex items-center gap-1 w-full text-left mb-2 cursor-pointer hover:bg-[rgba(90,169,255,0.08)] px-1 py-0.5"
                  title={tokOpen ? 'Свернуть' : 'Развернуть'}
                >
                  <span className={`text-[10px] shrink-0 ${tokOpen ? 'text-gold' : 'text-faint'}`}>{tokOpen ? '▾' : '▸'}</span>
                  <span className="tick-label">Фишки партии · {(map.mapTokens ?? []).length}/12</span>
                </button>
                {tokOpen && (
                  <div>
                    {tokens.length > 0 ? (
                      <div className="grid grid-cols-4 gap-1.5">
                        {tokens.map((t) => {
                          const on = (map.mapTokens ?? []).some((x) => x.id === t.id);
                          return (
                            <button
                              key={t.id}
                              title={t.name}
                              onClick={() => toggleMapToken(t)}
                              className={`relative aspect-square border-2 overflow-hidden cursor-pointer transition-transform hover:scale-105 ${on ? 'border-gold' : 'border-edge'}`}
                              style={{ background: 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 10px 10px' }}
                            >
                              <img src={t.dataUrl} alt={t.name} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
                              {on && <span className="absolute top-0 right-0 w-4 h-4 bg-gold text-abyss font-pixel text-[8px] flex items-center justify-center">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[10px] text-faint leading-tight">Фишек пока нет — нарисуйте или загрузите их в «Редакторе анимаций и фишек» (главное меню), затем вернитесь сюда.</p>
                    )}
                    <p className="text-[10px] text-faint mt-1.5 leading-tight">Отмеченные фишки вшиваются в карту и уезжают всем игрокам. После жеребьёвки каждый игрок выберет себе одну — одинаковые брать нельзя. Максимум 12.</p>
                  </div>
                )}
              </div>
              <div>
                <div className="tick-label mb-2">Ход фишек</div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => { updMap({ smoothMove: false }); sfx.hover(); }}
                    className={`flex-1 py-1.5 border-2 cursor-pointer font-display text-[9px] uppercase ${!map.smoothMove ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint hover:text-dim'}`}
                    title="Фишка перепрыгивает с клетки на клетку с подскоком — как в классических настолках. Для обычных фишек и «прыгающих» анимаций"
                  >Прыжками</button>
                  <button
                    onClick={() => { updMap({ smoothMove: true }); sfx.hover(); }}
                    className={`flex-1 py-1.5 border-2 cursor-pointer font-display text-[9px] uppercase ${map.smoothMove ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint hover:text-dim'}`}
                    title="Фишка идёт с постоянной скоростью по всему пути сразу — без прыжков и без остановок у каждой клетки. Для анимированных фишек с походкой"
                  >Плавно</button>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[10px] text-dim">Скорость хода</span>
                  <Stepper value={map.moveSpeed ?? 1.2} onChange={(v) => updMap({ moveSpeed: Math.round(v * 10) / 10 })} min={0.5} max={6} step={0.1} suffix=" кл/с" />
                </div>
                <p className="text-[10px] text-faint mt-1 leading-tight">Как двигаются фишки на этой карте: прыжками по клеткам (по умолчанию) или плавно — одним непрерывным движением от клетки до клетки назначения. Скорость — одна для ВСЕХ фишек карты, в клетках в секунду: подбирается автором карты и работает в обоих режимах.</p>
              </div>

              <div>
                <button
                  onClick={() => setAnimOpen((v) => !v)}
                  className="flex items-center gap-1 w-full text-left mb-2 cursor-pointer hover:bg-[rgba(90,169,255,0.08)] px-1 py-0.5"
                  title={animOpen ? 'Свернуть' : 'Развернуть'}
                >
                  <span className={`text-[10px] shrink-0 ${animOpen ? 'text-gold' : 'text-faint'}`}>{animOpen ? '▾' : '▸'}</span>
                  <span className="tick-label">Анимации · вшито {(map.animLib ?? []).length}</span>
                </button>
                {animOpen && (
                  <div>
                    {anims.length > 0 ? (
                      <div className="space-y-1 mb-2">
                        {anims.map((a) => {
                          const on = (map.animLib ?? []).some((x) => x.id === a.id);
                          return (
                            <div key={a.id} className={`flex items-center gap-1.5 border-2 px-1.5 py-1 ${on ? 'border-gold bg-[rgba(255,207,63,0.08)]' : 'border-edge'}`}>
                              <div className="w-8 h-8 shrink-0 flex items-center justify-center" style={{ background: 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 8px 8px' }}>
                                <AnimPreview frames={a.clip.frames} fps={a.clip.fps} size={28} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-display text-[10px] uppercase text-paper truncate">{a.snd ? '🔊 ' : ''}{a.name}</div>
                                <div className="tick-label text-faint">{a.clip.frames.length} кадр. · {a.clip.fps} кадр/с{a.snd ? ' · со звуком' : ''}</div>
                              </div>
                              <button
                                onClick={() => toggleMapAnim(a)}
                                title={on ? 'Убрать из карты (вместе с экземплярами на поле)' : 'Вшить в карту и размещать на поле'}
                                className={`shrink-0 w-6 h-6 border-2 font-pixel text-[10px] cursor-pointer ${on ? 'border-gold text-gold' : 'border-edge text-dim hover:text-paper'}`}
                              >{on ? '✓' : '+'}</button>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[10px] text-faint leading-tight mb-1.5">Анимаций пока нет — создайте их в «Редакторе анимаций и фишек» (главное меню → Все редакторы), затем вернитесь сюда.</p>
                    )}
                    {(map.animLib ?? []).length > 0 && (
                      <div>
                        <div className="tick-label mb-1">Разместить (выбери, затем инструмент «Анимация»):</div>
                        <div className="flex flex-wrap gap-1">
                          {(map.animLib ?? []).map((e) => (
                            <button
                              key={e.id}
                              onClick={() => { setPlaceAnimId(e.id); setTool('anim'); setSelAnim(null); sfx.hover(); }}
                              title={`Размещать «${e.name}» на карте${e.snd ? ' (со звуком)' : ''}`}
                              className={`px-1.5 py-1 border-2 font-display text-[8px] uppercase cursor-pointer ${placeAnimId === e.id ? 'border-gold text-gold' : 'border-edge text-dim hover:text-paper'}`}
                            >{e.snd ? '🔊 ' : ''}{e.name.slice(0, 10)}</button>
                          ))}
                        </div>
                      </div>
                    )}
                    <p className="text-[10px] text-faint mt-1.5 leading-tight">Вшитые анимации уезжают всем игрокам вместе с картой. Экземпляры можно двигать мышью, менять размер за жёлтый угол и слоями. 🔊 — у анимации есть звук: у её экземпляров на карте задаётся радиус.</p>
                  </div>
                )}
              </div>

              <div>
                <button
                  onClick={() => setBossOpen((v) => !v)}
                  className="flex items-center gap-1 w-full text-left mb-2 cursor-pointer hover:bg-[rgba(192,122,255,0.08)] px-1 py-0.5"
                  title={bossOpen ? 'Свернуть' : 'Развернуть'}
                >
                  <span className={`text-[10px] shrink-0 ${bossOpen ? 'text-gold' : 'text-faint'}`}>{bossOpen ? '▾' : '▸'}</span>
                  <span className="tick-label">👹 Боссы · вшито {(map.bossLib ?? []).length}</span>
                </button>
                {bossOpen && (
                  <div>
                    {bossAnims.length > 0 ? (
                      <div className="space-y-1 mb-2">
                        {bossAnims.map((b) => {
                          const on = (map.bossLib ?? []).some((x) => x.id === b.id);
                          return (
                            <div key={b.id} className={`flex items-center gap-1.5 border-2 px-1.5 py-1 ${on ? 'border-gold bg-[rgba(255,207,63,0.08)]' : 'border-edge'}`}>
                              <div className="w-8 h-8 shrink-0 flex items-center justify-center" style={{ background: 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 8px 8px' }}>
                                <AnimPreview frames={b.idle.frames} fps={b.idle.fps} size={28} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-display text-[10px] uppercase text-paper truncate">{b.idleSnd ? '🔊 ' : ''}{b.name}</div>
                                <div className="tick-label text-faint">🏆 {b.win.frames.length} к. · 💀 {b.lose.frames.length} к.</div>
                              </div>
                              <button
                                onClick={() => toggleMapBoss(b)}
                                title={on ? 'Убрать из карты (вместе с экземплярами на поле)' : 'Вшить в карту и размещать на поле'}
                                className={`shrink-0 w-6 h-6 border-2 font-pixel text-[10px] cursor-pointer ${on ? 'border-gold text-gold' : 'border-edge text-dim hover:text-paper'}`}
                              >{on ? '✓' : '+'}</button>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[10px] text-faint leading-tight mb-1.5">Боссов пока нет — создайте их в «Редакторе анимаций и фишек» (вкладка «👹 Боссы»): IDLE + реакции на победу/поражение игрока, затем вернитесь сюда.</p>
                    )}
                    {(map.bossLib ?? []).length > 0 && (
                      <div>
                        <div className="tick-label mb-1">Разместить (выбери, затем инструмент «Босс»):</div>
                        <div className="flex flex-wrap gap-1">
                          {(map.bossLib ?? []).map((e) => (
                            <button
                              key={e.id}
                              onClick={() => { setPlaceBossId(e.id); setTool('boss'); setSelBoss(null); sfx.hover(); }}
                              title={`Размещать «${e.name}» на карте`}
                              className={`px-1.5 py-1 border-2 font-display text-[8px] uppercase cursor-pointer ${placeBossId === e.id ? 'border-gold text-gold' : 'border-edge text-dim hover:text-paper'}`}
                            >{e.idleSnd ? '🔊 ' : ''}{e.name.slice(0, 10)}</button>
                          ))}
                        </div>
                      </div>
                    )}
                    <p className="text-[10px] text-faint mt-1.5 leading-tight">Босс живёт на ячейке: играет IDLE, а когда игрок в РАДИУСЕ побеждает/проигрывает задание — один раз реагирует клипом со своим звуком. Побеждённый (на его ячейке поставили своё задание) замерает статичным кадром. Радиус — в панели босса.</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="flex-1 min-w-0 relative">
          {/* центр: холст или заглушка */}
          {!map ? (
            <div className="h-full flex flex-col items-center justify-center gap-4 text-center p-6">
              <span className="text-teal floaty">{Ic.map(56)}</span>
              <div className="font-display uppercase text-paper text-lg">Выберите карту или создайте новую</div>
              <p className="text-[13px] text-dim max-w-md">
                Как в программе Tiled: загрузите общий фон, поверх ставьте тайлы любого размера и в несколько слоёв,
                а ячейки маршрута размещайте в любом месте и соединяйте стрелками. Круги и закоулки: сделайте ячейки БЕЗ НОМЕРА, нарисуйте по ним стрелки-дорогу, а вход и выход — стрелками ПЕРЕХОДА (прыжок при остановке фишки).
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
                className="w-full h-full block touch-none"
                style={{ cursor: tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={() => { setHoverW(null); onPointerUp(); }}
                onContextMenu={(e) => e.preventDefault()}
                onWheel={onWheel}
              />
              {/* инструменты */}
              <div className="absolute top-3 left-1/2 -translate-x-1/2 flex gap-1 hud-chip pixel-corners p-1.5 flex-wrap justify-center max-w-[95%]">
                {TOOLS.map((tl) => (
                  <button
                    key={tl.key}
                    title={tl.hint}
                    onClick={() => { setTool(tl.key); if (tl.key !== 'link' && tl.key !== 'hop') setLinkFrom(null); sfx.hover(); }}
                    className={`px-3 py-1.5 font-display text-[10px] uppercase tracking-wide transition-colors cursor-pointer ${tool === tl.key ? 'bg-gold text-abyss' : 'text-dim hover:text-paper'}`}
                  >
                    {tl.label}
                  </button>
                ))}
                <span className="w-px bg-edge mx-1" />
                <button onClick={() => setShowGrid((x) => !x)} className={`px-2 py-1.5 font-pixel text-[8px] uppercase cursor-pointer ${showGrid ? 'text-sky' : 'text-faint'}`} title="Сетка">сетка</button>
                <button onClick={() => setSnap((x) => !x)} className={`px-2 py-1.5 font-pixel text-[8px] uppercase cursor-pointer ${snap ? 'text-sky' : 'text-faint'}`} title="Привязка к мелкой сетке 16px">привязка</button>
                <button
                  onClick={() => { const cv = canvasRef.current; if (cv && map) setView(fitView(map, cv.clientWidth, cv.clientHeight)); }}
                  className="px-3 py-1.5 font-display text-[10px] uppercase text-sky hover:text-paper cursor-pointer"
                  title="Показать всю карту"
                >Вся карта</button>
              </div>

              {/* статус */}
              <div className="absolute bottom-3 left-3 hud-chip pixel-corners px-3 py-2 text-[11px] space-y-0.5 pointer-events-none">
                <div className={`font-display uppercase ${map.cells.length >= 10 ? 'text-teal' : 'text-gold'}`}>
                  Ячейки: {map.cells.length} / мин. 10 · стартовых: {startsCount}{(map.mode ?? 'classic') === 'rubg' ? ' / не нужна (самолёт)' : ' / нужна 1'}
                </div>
                <div className="text-dim">
                  Задания: {taskCells}{noTask > 0 ? <span className="text-magma"> (без рома: {noTask})</span> : ''}{restCells > 0 ? <span className="text-sky"> · передышек: {restCells}</span> : ''} · Тайлов: {(map.stamps ?? []).length} · {msz.w}×{msz.h}
                </div>
                {tool === 'link' && <div className="text-gold font-pixel text-[8px]">СТРЕЛКА: клик по ячейке А, затем по Б · Esc — отмена{linkFrom !== null ? ' · выбрана А, жмите Б' : ''}</div>}
                {tool === 'hop' && <div className="text-coral font-pixel text-[8px]">ПЕРЕХОД: клик по ячейке А, затем по Б — при остановке на А фишка прыгнет на Б · Esc — отмена{linkFrom !== null ? ' · выбрана А, жмите Б' : ''}</div>}
                {tool === 'erase' && <div className="text-coral font-pixel text-[8px]">ЛАСТИК: клик или тяните с кнопкой — стирает ТАЙЛЫ под курсором · ячейки не трогает</div>}
                {tool === 'wall' && <div className="text-coral font-pixel text-[8px]">СТЕНА: протяните прямоугольник — фишка не зайдёт внутрь (работает ТОЛЬКО в JOURNEY, в игре невидима) · клик по стене — выбрать и тянуть · Delete — удалить</div>}
                {tool === 'portal' && <div className="text-[rgb(192,122,255)] font-pixel text-[8px]">{pickTargetFor !== null ? `ПОРТАЛ ${pickTargetFor + 1}: кликните по карте — КУДА переносить (плитку переключите в панели «Плитки и порталы») · Esc — отмена` : 'ПОРТАЛ: протяните зону входа · после этого кликните по карте — куда переносить · клик по порталу — выбрать и тянуть · Delete — удалить'}</div>}
              </div>
              <div className="absolute bottom-3 right-3 tick-label text-faint text-right pointer-events-none">
                колесо — зум · ПКМ — камера · Delete — удалить (по режиму из Опций) · R — поворот · жёлтый угол тайла — размер
              </div>

              {/* панель ячейки */}
              {selCellDef && selCell !== null && (
                <div className="absolute top-14 right-3 w-[264px] pixel-panel pixel-corners p-3.5 space-y-3 pop-in shadow-[0_14px_40px_rgba(0,0,0,0.6)] max-h-[80%] overflow-y-auto">
                  <div className="flex items-center justify-between">
                    <span className="font-display uppercase text-[12px] text-gold">{selCellDef.nonumber ? 'Ячейка без номера' : `Ячейка №${selCellDef.n}`}{selCellDef.next !== undefined ? ' ↗' : ''}{selCellDef.hop !== undefined ? ' ⇢' : ''}</span>
                    <button onClick={() => { setSelCell(null); sfx.hover(); }} className="text-dim hover:text-coral cursor-pointer" aria-label="Закрыть">{Ic.cross(14)}</button>
                  </div>

                  <div>
                    <div className="tick-label mb-1.5">Тип</div>
                    <div className="grid grid-cols-7 gap-1">
                      {[...CELL_TYPES, ...((map.mode ?? 'classic') === 'rubg' ? [LOOT_CELL_TYPE] : [])].map((t) => (
                        <button
                          key={t.key}
                          onClick={() => { updCell(selCell, { type: t.key }); renumber(); dirtyRef.current = true; }}
                          className={`py-1.5 font-display text-[8px] uppercase border-2 transition-colors cursor-pointer ${selCellDef.type === t.key ? t.cls : 'border-edge text-faint hover:text-dim'}`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    {selCellDef.type === 'start' && (
                      <p className="text-[10px] text-teal mt-1 leading-tight">Игроки начнут партию с этой ячейки. Задание ей не нужно.</p>
                    )}
                    {selCellDef.type === 'rest' && (
                      <p className="text-[10px] text-sky mt-1 leading-tight">Пустая клетка-передышка: ничего не происходит, ход просто переходит дальше. Ром не нужен — «без рома» не считается.</p>
                    )}
                    {selCellDef.type === 'loot' && (
                      <p className="text-[10px] text-[#ff8b3f] mt-1 leading-tight">ЛУТБОКС (только RUBG): одноразовый. Зашедший игрок вскрыает его и получает случайный предмет: фляжку/аптечку/ящик (лечение), пистолет/ПП/снайперку (атаки), карту воровства (3 исп.) или карту стелса.</p>
                    )}
                    <button
                      onClick={() => {
                        const willHide = !selCellDef.nonumber;
                        updCell(selCell, { nonumber: willHide });
                        dirtyRef.current = true; sfx.hover();
                        toast(willHide
                          ? 'Ячейка БЕЗ НОМЕРА: основной путь её перескакивает — рисуй стрелку-дорогу'
                          : 'Ячейке возвращён номер — она снова в основном пути', 'info');
                      }}
                      title="Без номера — клетка круга/закоулка: основной путь по номерам её ПЕРЕСКАКИВАЕТ, попасть можно только по стрелке. Номера остальных ячеек НЕ сдвигаются"
                      className={`w-full mt-1.5 py-1.5 font-display text-[9px] uppercase border-2 cursor-pointer transition-colors ${selCellDef.nonumber ? 'border-coral text-coral bg-coral/10' : 'border-edge text-faint hover:text-dim'}`}
                    >{selCellDef.nonumber ? '✓ Без номера — клик, вернуть номер' : 'Сделать БЕЗ НОМЕРА (для кругов)'}</button>
                  </div>

                  <div>
                    <div className="tick-label mb-1.5">Размер (px)</div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between"><span className="text-[10px] text-dim">Ширина</span><Stepper value={selCellDef.cw ?? CELL} onChange={(v) => { updCell(selCell, { cw: v }); lastCellSize.current.w = v; }} min={40} max={640} step={8} /></div>
                      <div className="flex items-center justify-between"><span className="text-[10px] text-dim">Высота</span><Stepper value={selCellDef.ch ?? CELL} onChange={(v) => { updCell(selCell, { ch: v }); lastCellSize.current.h = v; }} min={40} max={640} step={8} /></div>
                    </div>
                    <p className="text-[10px] text-faint mt-1">Крупная ячейка (от 72px) — «улица»: картинка задания и название.</p>
                    <div className="flex gap-1.5 mt-1.5">
                      <GhostBtn
                        small
                        className="flex-1"
                        title="Новые ячейки будут ставиться такого же размера"
                        onClick={() => { lastCellSize.current = { w: selCellDef.cw ?? CELL, h: selCellDef.ch ?? CELL }; sfx.hover(); toast(`Новые ячейки: ${selCellDef.cw ?? CELL}×${selCellDef.ch ?? CELL}`, 'ok'); }}
                      >Запомнить</GhostBtn>
                      <GhostBtn
                        small
                        className="flex-1"
                        title="Сделать этот размер у ВСЕХ ячеек карты"
                        onClick={() => {
                          const w = selCellDef.cw ?? CELL, h = selCellDef.ch ?? CELL;
                          setMap((mm) => (mm ? { ...mm, cells: mm.cells.map((c) => ({ ...c, cw: w, ch: h })) } : mm));
                          lastCellSize.current = { w, h };
                          dirtyRef.current = true;
                          sfx.hover();
                          toast(`Размер ${w}×${h} у всех ячеек`, 'ok');
                        }}
                      >Такой у всех</GhostBtn>
                    </div>
                  </div>

                  <div>
                    <div className="tick-label mb-1.5">Стрелка маршрута</div>
                    {selCellDef.next !== undefined && map.cells[selCellDef.next] ? (
                      <div className="text-[11px] text-gold mb-1.5">Ведёт в ячейку №{map.cells[selCellDef.next].n}{selCellDef.nonumber ? ' — по ней фишка ШАГАЕТ' : ' — прыжок при остановке'}</div>
                    ) : (
                      <div className={`text-[11px] mb-1.5 ${selCellDef.nonumber ? 'text-coral' : 'text-dim'}`}>
                        {selCellDef.nonumber ? 'Нет стрелки — фишка здесь ЗАСТРЯНЕТ! Нарисуй стрелку-дорогу' : 'Авто — в следующую по порядку создания'}
                      </div>
                    )}
                    <div className="flex gap-1.5">
                      <GhostBtn
                        small
                        className="flex-1"
                        onClick={() => { setTool('link'); setLinkFrom(selCell); toast('Теперь кликните по ячейке, куда должна вести стрелка', 'info'); }}
                      >Задать стрелку</GhostBtn>
                      {selCellDef.next !== undefined && (
                        <GhostBtn small onClick={() => setLink(selCell, null)}>Авто</GhostBtn>
                      )}
                    </div>
                    {selCellDef.next !== undefined && (
                      <div className="mt-2 pt-2 border-t border-edge space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-dim">Толщина</span>
                          <Stepper value={selCellDef.nextStyle?.w ?? 8} min={2} max={24} suffix=" px" onChange={(v) => { updCell(selCell, { nextStyle: { ...selCellDef.nextStyle, w: v } }); dirtyRef.current = true; }} />
                        </div>
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="text-[10px] text-dim mr-0.5">Цвет</span>
                          {ARROW_COLORS.map((cc) => (
                            <button
                              key={cc || 'def'}
                              onClick={() => { updCell(selCell, { nextStyle: { ...selCellDef.nextStyle, col: cc || undefined } }); dirtyRef.current = true; sfx.hover(); }}
                              className={`w-[18px] h-[18px] border-2 cursor-pointer ${((selCellDef.nextStyle?.col ?? '') === cc) ? 'border-gold' : 'border-edge'}`}
                              style={cc ? { background: cc } : { background: 'repeating-conic-gradient(#313c72 0 25%, #0b0e1c 0 50%) 0 0/6px 6px' }}
                              title={cc ? 'Цвет стрелки' : 'Обычный (золотая)'}
                            />
                          ))}
                        </div>
                    <div className="flex gap-1.5">
                          <GhostBtn small className="flex-1" onClick={() => { updCell(selCell, { nextStyle: { ...selCellDef.nextStyle, dash: !selCellDef.nextStyle?.dash } }); dirtyRef.current = true; sfx.hover(); }}>
                            {selCellDef.nextStyle?.dash ? '✓ Пунктир' : 'Пунктир'}
                          </GhostBtn>
                          <GhostBtn small className="flex-1" onClick={() => { updCell(selCell, { nextStyle: { ...selCellDef.nextStyle, head: !(selCellDef.nextStyle?.head ?? true) } }); dirtyRef.current = true; sfx.hover(); }}>
                            {selCellDef.nextStyle?.head === false ? 'Без острия' : '✓ Наконечник'}
                          </GhostBtn>
                        </div>
                        <GhostBtn
                          small
                          className="w-full"
                          title="ВКЛ — стрелка заходит на клетку: конец утоплен в ячейку, остриё рисуется поверх клеток. ВЫКЛ — стрелка целиком останавливается у границы ячейки, не налезая на неё"
                          onClick={() => { updCell(selCell, { nextStyle: { ...selCellDef.nextStyle, over: !(selCellDef.nextStyle?.over ?? true) } }); dirtyRef.current = true; sfx.hover(); }}
                        >
                          {(selCellDef.nextStyle?.over ?? true) ? '✓ Заходит на клетку' : 'У края клетки'}
                        </GhostBtn>
                        <p className="text-[9.5px] text-faint leading-tight">Стрелка по умолчанию ЖИРНАЯ (8px) с остриём — сразу видно, куда пойдёт фишка.</p>
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="tick-label mb-1.5">Стрелка ПЕРЕХОДА (вторая стрелка)</div>
                    {selCellDef.hop !== undefined && map.cells[selCellDef.hop] ? (
                      <div className="text-[11px] text-coral mb-1.5">Прыжок в ячейку №{map.cells[selCellDef.hop].n} — когда фишка ОСТАНОВИТСЯ здесь</div>
                    ) : (
                      <div className="text-[11px] text-dim mb-1.5">Нет — при остановке фишка просто стоит</div>
                    )}
                    <div className="flex gap-1.5">
                      <GhostBtn
                        small
                        className="flex-1"
                        onClick={() => { setTool('hop'); setLinkFrom(selCell); toast('Теперь кликните по ячейке, куда фишка прыгнет при остановке здесь', 'info'); }}
                      >Задать переход</GhostBtn>
                      {selCellDef.hop !== undefined && (
                        <GhostBtn small onClick={() => setHop(selCell, null)}>Убрать</GhostBtn>
                      )}
                    </div>
                    {selCellDef.hop !== undefined && (
                      <div className="mt-2 pt-2 border-t border-edge space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-dim">Толщина</span>
                          <Stepper value={selCellDef.hopStyle?.w ?? 8} min={2} max={24} suffix=" px" onChange={(v) => { updCell(selCell, { hopStyle: { ...selCellDef.hopStyle, w: v } }); dirtyRef.current = true; }} />
                        </div>
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="text-[10px] text-dim mr-0.5">Цвет</span>
                          {ARROW_COLORS.map((cc) => (
                            <button
                              key={cc || 'def'}
                              onClick={() => { updCell(selCell, { hopStyle: { ...selCellDef.hopStyle, col: cc || undefined } }); dirtyRef.current = true; sfx.hover(); }}
                              className={`w-[18px] h-[18px] border-2 cursor-pointer ${((selCellDef.hopStyle?.col ?? '') === cc) ? 'border-gold' : 'border-edge'}`}
                              style={cc ? { background: cc } : { background: 'repeating-conic-gradient(#313c72 0 25%, #0b0e1c 0 50%) 0 0/6px 6px' }}
                              title={cc ? 'Цвет стрелки' : 'Обычный (коралловая)'}
                            />
                          ))}
                        </div>
                        <div className="flex gap-1.5">
                          <GhostBtn small className="flex-1" onClick={() => { updCell(selCell, { hopStyle: { ...selCellDef.hopStyle, dash: !selCellDef.hopStyle?.dash } }); dirtyRef.current = true; sfx.hover(); }}>
                            {selCellDef.hopStyle?.dash ? '✓ Пунктир' : 'Пунктир'}
                          </GhostBtn>
                          <GhostBtn small className="flex-1" onClick={() => { updCell(selCell, { hopStyle: { ...selCellDef.hopStyle, head: !(selCellDef.hopStyle?.head ?? true) } }); dirtyRef.current = true; sfx.hover(); }}>
                            {selCellDef.hopStyle?.head === false ? 'Без острия' : '✓ Наконечник'}
                          </GhostBtn>
                        </div>
                        <GhostBtn
                          small
                          className="w-full"
                          title="ВКЛ — стрелка заходит на клетку: конец утоплен в ячейку, остриё рисуется поверх клеток. ВЫКЛ — стрелка целиком останавливается у границы ячейки, не налезая на неё"
                          onClick={() => { updCell(selCell, { hopStyle: { ...selCellDef.hopStyle, over: !(selCellDef.hopStyle?.over ?? true) } }); dirtyRef.current = true; sfx.hover(); }}
                        >
                          {(selCellDef.hopStyle?.over ?? true) ? '✓ Заходит на клетку' : 'У края клетки'}
                        </GhostBtn>
                        <p className="text-[9.5px] text-faint leading-tight">ПЕРЕХОД по умолчанию ЖИРНЫЙ (8px) с остриём — видно, куда прыгнет фишка.</p>
                      </div>
                    )}
                    <p className="text-[10px] text-faint mt-1 leading-tight">ПЕРЕХОД (коралловая стрелка) срабатывает, только когда фишка ОСТАНОВИЛАСЬ на ячейке: выход из круга, штраф-телепорт. Проходом мимо — не срабатывает.</p>
                  </div>

                  <div>
                    <p className="text-[10px] text-faint leading-tight">КАК ХОДИТ ФИШКА: по пронумерованным — по порядку номеров, БЕЗНОМЕРНЫЕ перескакивает (№3 → №8). На безномерной — по её стрелке-дороге. Остановилась на ячейке со стрелкой перехода — прыгнула по ней и выполняет ту ячейку, на которой стоит.
                    Пример круга: путь 1..10, ячейки 4,5,6,7 — «Без номера», стрелки 3→4, 4→5, 5→6, 6→4 (дорога), с №6 переход на №8 (выход).</p>
                  </div>

                  <div>
                    <div className="tick-label mb-1.5">Цвет группы</div>
                    <div className="flex gap-1 flex-wrap">
                      {CELL_COLORS.map((c) => (
                        <button
                          key={c || 'none'}
                          onClick={() => updCell(selCell, { color: c || undefined })}
                          title={c || 'Без цвета'}
                          className={`w-6 h-6 border-2 cursor-pointer transition-transform hover:scale-110 ${(selCellDef.color || '') === c ? 'border-paper scale-110' : 'border-abyss'}`}
                          style={{ background: c || 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 10px 10px' }}
                        />
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="tick-label mb-1.5">Короткое название</div>
                    <input
                      className="field-in w-full px-2.5 py-1.5 text-[12px]"
                      maxLength={14}
                      placeholder="Напр.: FELIX"
                      value={selCellDef.label ?? ''}
                      onChange={(e) => updCell(selCell, { label: e.target.value.trim() || undefined })}
                    />
                  </div>

                  <HoldDeleteButton
                    onFire={() => deleteCell(selCell)}
                    label="ячейку маршрута"
                    ariaLabel="Удалить ячейку"
                    title="Удалить ячейку"
                    className="w-full py-1.5 border-2 border-coral/60 text-coral font-display text-[10px] uppercase hover:bg-coral/10 transition-colors cursor-pointer"
                  >
                    Удалить ячейку
                  </HoldDeleteButton>
                </div>
              )}

              {/* панель тайла */}
              {selStampDef && !selCellDef && (
                <div className="absolute top-14 right-3 w-[264px] pixel-panel pixel-corners p-3.5 space-y-3 pop-in shadow-[0_14px_40px_rgba(0,0,0,0.6)]">
                  <div className="flex items-center justify-between">
                    <span className="font-display uppercase text-[12px] text-gold truncate">Тайл · {selTileDef?.name ?? '?'}</span>
                    <button onClick={() => { setSelStamp(null); sfx.hover(); }} className="text-dim hover:text-coral cursor-pointer" aria-label="Закрыть">{Ic.cross(14)}</button>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between"><span className="text-[10px] text-dim">Ширина</span><Stepper value={Math.round(selStampDef.w)} onChange={(v) => { updStamp(selStampIdx, { w: v }); dirtyRef.current = true; }} min={8} max={2048} step={8} /></div>
                    <div className="flex items-center justify-between"><span className="text-[10px] text-dim">Высота</span><Stepper value={Math.round(selStampDef.h)} onChange={(v) => { updStamp(selStampIdx, { h: v }); dirtyRef.current = true; }} min={8} max={2048} step={8} /></div>
                  </div>
                  <p className="text-[10px] text-gold leading-tight">Тяните жёлтый УГОЛОК рамки на карте — меняете размер мышью. Центр не двигается.</p>

                  <div className="grid grid-cols-2 gap-1.5">
                    <GhostBtn small onClick={() => { updStamp(selStampIdx, { rot: (selStampDef.rot + 1) % 4 }); dirtyRef.current = true; sfx.hover(); }}>Повернуть 90°</GhostBtn>
                    <GhostBtn small onClick={() => { updStamp(selStampIdx, { flip: !selStampDef.flip }); dirtyRef.current = true; sfx.hover(); }} title="Отразить по горизонтали — для тайлов, нарисованных только в одну сторону (клавиша F)">Зеркало {selStampDef.flip ? '✓' : ''}</GhostBtn>
                    <GhostBtn small onClick={() => {
                      const copy: Stamp = { ...selStampDef, id: uid('st'), x: selStampDef.x + 16, y: selStampDef.y + 16 };
                      setMap((mm) => (mm ? { ...mm, stamps: [...(mm.stamps ?? []), copy] } : mm));
                      setSelStamp(copy.id);
                      dirtyRef.current = true;
                      sfx.hover();
                    }}>Дублировать</GhostBtn>
                    <GhostBtn small onClick={() => {
                      const cur = selStampDef.layer ?? 0;
                      const maxL = (map.tileLayers ?? 2) - 1;
                      if (cur < maxL) {
                        updStamp(selStampIdx, { layer: cur + 1 });
                      } else {
                        // уже верхний слой — поднимаем НАД ВСЕМИ тайлами этого слоя (в конец массива)
                        const arr = [...(map.stamps ?? [])];
                        const [st] = arr.splice(selStampIdx, 1);
                        if (st) arr.push(st);
                        updMap({ stamps: arr });
                        toast('Тайл поднят над всеми тайлами верхнего слоя', 'info');
                      }
                      dirtyRef.current = true;
                      sfx.hover();
                    }} title="СЛОЙ ВЫШЕ: тайл перекроет тайлы нижних слоёв">Слой +</GhostBtn>
                    <GhostBtn small onClick={() => {
                      const cur = selStampDef.layer ?? 0;
                      if (cur > 0) {
                        updStamp(selStampIdx, { layer: cur - 1 });
                      } else {
                        // уже нижний слой — опускаем ПОД ВСЕ тайлы этого слоя (в начало массива)
                        const arr = [...(map.stamps ?? [])];
                        const [st] = arr.splice(selStampIdx, 1);
                        if (st) arr.unshift(st);
                        updMap({ stamps: arr });
                        toast('Тайл опущен под все тайлы нижнего слоя', 'info');
                      }
                      dirtyRef.current = true;
                      sfx.hover();
                    }} title="СЛОЙ НИЖЕ: тайл уйдёт ПОД тайлы верхних слоёв">Слой −</GhostBtn>
                  </div>
                  <p className="text-[10px] text-gold leading-tight">Слой {(selStampDef.layer ?? 0) + 1} из {map.tileLayers ?? 2}. «Слой ±» переносит тайл между слоями; на крайнем — под/над всеми тайлами этого слоя.</p>

                  <HoldDeleteButton
                    onFire={() => deleteStampNow(selStampIdx)}
                    label={`тайл «${selTileDef?.name ?? '?'}» с карты`}
                    ariaLabel="Удалить тайл с карты"
                    title="Удалить тайл с карты"
                    className="w-full py-1.5 border-2 border-coral/60 text-coral font-display text-[10px] uppercase hover:bg-coral/10 transition-colors cursor-pointer"
                  >
                    Удалить тайл
                  </HoldDeleteButton>
                </div>
              )}

              {/* панель размещённой анимации */}
              {selAnimDef && !selCellDef && !selStampDef && (
                <div className="absolute top-14 right-3 w-[264px] pixel-panel pixel-corners p-3.5 space-y-3 pop-in shadow-[0_14px_40px_rgba(0,0,0,0.6)]">
                  <div className="flex items-center justify-between">
                    <span className="font-display uppercase text-[12px] text-gold truncate">Анимация · {selAnimLib?.name ?? '?'}</span>
                    <button onClick={() => { setSelAnim(null); sfx.hover(); }} className="text-dim hover:text-coral cursor-pointer" aria-label="Закрыть">{Ic.cross(14)}</button>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="w-14 h-14 shrink-0 flex items-center justify-center border-2 border-edge" style={{ background: 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 10px 10px' }}>
                      <AnimPreview frames={selAnimLib?.clip.frames ?? []} fps={selAnimLib?.clip.fps} size={48} />
                    </div>
                    <div className="text-[10px] text-dim">
                      {selAnimLib?.clip.frames.length ?? 0} кадр. · {selAnimLib?.clip.fps ?? 0} кадр/с
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between"><span className="text-[10px] text-dim">Ширина</span><Stepper value={Math.round(selAnimDef.w)} onChange={(v) => { updAnim(selAnimIdx, { w: v }); dirtyRef.current = true; }} min={12} max={2048} step={8} /></div>
                    <div className="flex items-center justify-between"><span className="text-[10px] text-dim">Высота</span><Stepper value={Math.round(selAnimDef.h)} onChange={(v) => { updAnim(selAnimIdx, { h: v }); dirtyRef.current = true; }} min={12} max={2048} step={8} /></div>
                  </div>
                  {selAnimLib?.snd ? (
                    <div className="space-y-1 border-2 border-teal/40 px-2 py-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-teal">🔊 Радиус звука</span>
                        <Stepper value={selAnimDef.r ?? 0} onChange={(v) => { updAnim(selAnimIdx, { r: v }); dirtyRef.current = true; }} min={0} max={3000} step={10} suffix=" px" />
                      </div>
                      <p className="text-[10px] text-teal leading-tight">Фишка ИГРАЮЩЕГО вошла в круг — звук анимации играет, только у него; в задании он приглушается. 0 = молчит. Пунктирный круг виден только в редакторе.</p>
                    </div>
                  ) : (
                    <p className="text-[10px] text-faint leading-tight">У этой анимации звука нет — прикрепите его в «Редакторе анимаций и фишек» (спойлер «Звуки»), затем пере-вшите её в карту.</p>
                  )}
                  <p className="text-[10px] text-gold leading-tight">Тяните жёлтый УГОЛОК рамки на карте — меняете размер мышью. Центр не двигается.</p>

                  <div className="grid grid-cols-2 gap-1.5">
                    <GhostBtn small onClick={() => {
                      const copy: PlacedAnim = { ...selAnimDef, id: uid('anim'), x: selAnimDef.x + 16, y: selAnimDef.y + 16 };
                      setMap((mm) => (mm ? { ...mm, anims: [...(mm.anims ?? []), copy] } : mm));
                      setSelAnim(copy.id);
                      dirtyRef.current = true;
                      sfx.hover();
                    }}>Дублировать</GhostBtn>
                    <GhostBtn small onClick={() => {
                      const arr = map!.anims!;
                      if (selAnimIdx >= arr.length - 1) return;
                      const a2 = arr.slice();
                      [a2[selAnimIdx], a2[selAnimIdx + 1]] = [a2[selAnimIdx + 1], a2[selAnimIdx]];
                      updMap({ anims: a2 });
                      dirtyRef.current = true;
                    }} title="Выше по слоям (перекрывает соседей)">Слой +</GhostBtn>
                    <GhostBtn small onClick={() => {
                      const arr = map!.anims!;
                      if (selAnimIdx <= 0) return;
                      const a2 = arr.slice();
                      [a2[selAnimIdx], a2[selAnimIdx - 1]] = [a2[selAnimIdx - 1], a2[selAnimIdx]];
                      updMap({ anims: a2 });
                      dirtyRef.current = true;
                    }} title="Ниже по слоям (под соседями)">Слой −</GhostBtn>
                    <GhostBtn small onClick={() => { setPlaceAnimId(selAnimDef.aid); sfx.hover(); toast('Кликайте по полю — поставите ещё экземпляры этой анимации', 'info'); }}>Ставить ещё</GhostBtn>
                  </div>

                  <HoldDeleteButton
                    onFire={() => removeAnim(selAnimDef.id)}
                    label={`анимацию «${selAnimLib?.name ?? '?'}» с карты`}
                    ariaLabel="Удалить анимацию с карты"
                    title="Удалить анимацию с карты"
                    className="w-full py-1.5 border-2 border-coral/60 text-coral font-display text-[10px] uppercase hover:bg-coral/10 transition-colors cursor-pointer"
                  >
                    Удалить анимацию
                  </HoldDeleteButton>
                </div>
              )}

              {/* панель размещённого босса */}
              {selBossDef && !selCellDef && !selStampDef && !selAnimDef && (
                <div className="absolute top-14 right-3 w-[264px] pixel-panel pixel-corners p-3.5 space-y-3 pop-in shadow-[0_14px_40px_rgba(0,0,0,0.6)]">
                  <div className="flex items-center justify-between">
                    <span className="font-display uppercase text-[12px] text-gold truncate">👹 Босс · {selBossLib?.name ?? '?'}</span>
                    <button onClick={() => { setSelBoss(null); sfx.hover(); }} className="text-dim hover:text-coral cursor-pointer" aria-label="Закрыть">{Ic.cross(14)}</button>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="w-14 h-14 shrink-0 flex items-center justify-center border-2 border-edge" style={{ background: 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 10px 10px' }}>
                      <AnimPreview frames={selBossLib?.idle.frames ?? []} fps={selBossLib?.idle.fps} size={48} />
                    </div>
                    <div className="text-[10px] text-dim">
                      IDLE {selBossLib?.idle.frames.length ?? 0} к. · 🏆 {selBossLib?.win.frames.length ?? 0} к. · 💀 {selBossLib?.lose.frames.length ?? 0} к.
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between"><span className="text-[10px] text-dim">Ширина</span><Stepper value={Math.round(selBossDef.w)} onChange={(v) => { updBoss(selBossIdx, { w: v }); dirtyRef.current = true; }} min={12} max={2048} step={8} /></div>
                    <div className="flex items-center justify-between"><span className="text-[10px] text-dim">Высота</span><Stepper value={Math.round(selBossDef.h)} onChange={(v) => { updBoss(selBossIdx, { h: v }); dirtyRef.current = true; }} min={12} max={2048} step={8} /></div>
                  </div>

                  <div className="space-y-1 border-2 border-[rgba(192,122,255,0.4)] px-2 py-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-[#c07aff]">👹 Радиус босса</span>
                      <Stepper value={selBossDef.r ?? 0} onChange={(v) => { updBoss(selBossIdx, { r: v }); dirtyRef.current = true; }} min={0} max={3000} step={10} suffix=" px" />
                    </div>
                    <p className="text-[10px] text-[#c07aff] leading-tight">Игрок ВНУТРИ круга победил/проиграл задание — босс ОДИН раз реагирует клипом со своим звуком. Победили задание на ячейке босса и поставили своё — он повержен и замер статичным кадром. 0 = молчит и не реагирует. Круг виден только в редакторе.</p>
                  </div>
                  <p className="text-[10px] text-gold leading-tight">Тяните жёлтый УГОЛОК рамки — меняете размер мышью. Тяните тело — двигаете босса.</p>

                  <div className="grid grid-cols-2 gap-1.5">
                    <GhostBtn small onClick={() => {
                      const copy: PlacedBoss = { ...selBossDef, id: uid('boss'), x: selBossDef.x + 16, y: selBossDef.y + 16 };
                      setMap((mm) => (mm ? { ...mm, bosses: [...(mm.bosses ?? []), copy] } : mm));
                      setSelBoss(copy.id);
                      dirtyRef.current = true;
                      sfx.hover();
                    }}>Дублировать</GhostBtn>
                    <GhostBtn small onClick={() => { setPlaceBossId(selBossDef.bid); sfx.hover(); toast('Кликайте по полю — поставите ещё экземпляры этого босса', 'info'); }}>Ставить ещё</GhostBtn>
                  </div>

                  <HoldDeleteButton
                    onFire={() => removeBossAt(selBossDef.id)}
                    label={`босса «${selBossLib?.name ?? '?'}» с карты`}
                    ariaLabel="Удалить босса с карты"
                    title="Удалить босса с карты"
                    className="w-full py-1.5 border-2 border-coral/60 text-coral font-display text-[10px] uppercase hover:bg-coral/10 transition-colors cursor-pointer"
                  >
                    Удалить босса
                  </HoldDeleteButton>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* скрытые поля выбора файлов */}
      <input ref={folderRef} type="file" multiple accept="image/*" style={{ display: 'none' }} {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)} onChange={(e) => { void addTileFiles(e.target.files, 'folder'); e.currentTarget.value = ''; }} />
      <input ref={filesRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={(e) => { void addTileFiles(e.target.files, 'files'); e.currentTarget.value = ''; }} />
      <input ref={bgRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { void setBg(e.target.files); e.currentTarget.value = ''; }} />
      <input ref={extRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { void openExtract(e.target.files?.[0]); e.currentTarget.value = ''; }} />

      {/* окошко подтверждения / полоска удержания для Delete-клавиши (режим из Опций) */}
      {keyDel.node}

      {extract && (
        <Modal title="Нарезка тайлов из картинки" icon={Ic.map(16)} onClose={closeExtract} w="max-w-2xl">
          <p className="text-[12px] text-dim mb-3">
            Картинка с тайлами на однотонном фоне. Укажите фон (клик по превью = пипетка, или АВТО/палитра),
            подберите допуск, минимальный размер и склейку — нарезка пересчитается сама. Результат добавится в палитру отдельным спойлером.
          </p>
          <div className="flex gap-3 mb-3">
            <img
              src={extract.src}
              alt="исходник"
              onClick={pipetteBg}
              className="w-36 h-36 shrink-0 object-contain border-2 border-edge bg-[repeating-conic-gradient(#141833_0_25%,#0b0e1c_0_50%)_0_0/12px_12px] cursor-crosshair"
              title="Клик — взять цвет фона пипеткой"
            />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-dim shrink-0">Фон:</span>
                <button
                  onClick={() => tuneExtract({ bgMode: 'auto' })}
                  className={`px-2 py-1 text-[9px] font-pixel border-2 cursor-pointer ${extract.bgMode === 'auto' ? 'border-gold text-gold' : 'border-edge text-faint hover:text-dim'}`}
                  title="Найти фон автоматически (самый частый цвет картинки)"
                >АВТО</button>
                <input
                  type="color"
                  value={extract.bg}
                  onChange={(e) => tuneExtract({ bgMode: 'custom', bg: e.target.value })}
                  className="w-8 h-8 border-2 border-edge bg-transparent cursor-pointer p-0"
                  title="Выбрать цвет фона палитрой"
                />
                <span className="tick-label text-faint truncate">
                  {extract.bgMode === 'custom' ? extract.bg : (extract.foundBg || '…')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-dim">Допуск фона</span>
                <Stepper value={extract.thr} onChange={(v) => tuneExtract({ thr: v })} min={0} max={200} step={5} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-dim">Мин. размер (px)</span>
                <Stepper value={extract.minSize} onChange={(v) => tuneExtract({ minSize: v })} min={2} max={120} step={2} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-dim">Склейка частей (px)</span>
                <Stepper value={extract.mergeGap} onChange={(v) => tuneExtract({ mergeGap: v })} min={0} max={20} step={1} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-dim">Мелкий текст (подписи)</span>
                <button
                  onClick={() => tuneExtract({ keepText: !extract.keepText })}
                  className={`px-2 py-1 text-[9px] font-pixel border-2 cursor-pointer ${extract.keepText ? 'border-gold text-gold' : 'border-edge text-faint hover:text-dim'}`}
                  title="Мелкий чёрно-белый текст (подписи автора на листе): выбросить или оставить"
                >{extract.keepText ? 'ОСТАВИТЬ' : 'ВЫБРОСИТЬ'}</button>
              </div>
              <p className="text-[10px] text-faint leading-tight">
                ЛИШНЕЕ прилипло к тайлам — уменьшите допуск. Тайл РАЗВАЛИЛСЯ на части — увеличьте склейку.
                Разные тайлы СЛИПЛИСЬ — уменьшите склейку (и проверьте фон пипеткой). Мусор в списке — увеличьте мин. размер.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-dim shrink-0">Название:</span>
                <input
                  className="field-in flex-1 min-w-0 px-2 py-1 text-[12px]"
                  maxLength={20}
                  value={extract.name}
                  onChange={(e) => setExtract((ex) => (ex ? { ...ex, name: e.target.value } : ex))}
                />
              </div>
              {extract.busy && <div className="text-gold font-display text-[10px] uppercase animate-pulse">Нарезаю…</div>}
            </div>
          </div>
          {extract.tiles.length > 0 && (
            <div className="grid grid-cols-8 gap-1.5 mb-3 max-h-44 overflow-y-auto border-2 border-edge p-1.5 bg-[rgba(11,14,28,0.6)]">
              {extract.tiles.map((t) => (
                <div key={t.id} className="aspect-square border border-edge bg-[repeating-conic-gradient(#141833_0_25%,#0b0e1c_0_50%)_0_0/8px_8px] overflow-hidden" title={`Тайл ${t.name}`}>
                  <img src={t.dataUrl} alt={t.name} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-3">
            <GhostBtn onClick={closeExtract}>Отмена</GhostBtn>
            <PxBtn color="teal" onClick={addExtractToPalette} disabled={!extract.tiles.length || extract.busy}>
              {Ic.plus(12)} В палитру ({extract.tiles.length})
            </PxBtn>
          </div>
        </Modal>
      )}

      {nameModal && (
        <Modal title="Карта готова?" icon={Ic.map(16)} onClose={() => setNameModal(false)} w="max-w-md">
          <p className="text-[13px] text-dim mb-4">
            Ячеек: {map?.cells.length} · фон и тайлы уедут игрокам вместе с картой. Название увидят все в комнате.
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

