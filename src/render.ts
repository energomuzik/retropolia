import type { CellDef, GameMap, TileDef, TileImg } from './types';
import { getImage } from './assets';

export const CELL = 64;

/* Размер поля в пикселях: новые карты хранят mw/mh, старые — сетку cols×rows по 64px */
export const mapSize = (map: GameMap) => ({
  w: map.mw ?? map.cols * CELL,
  h: map.mh ?? map.rows * CELL,
});

/* Совместимость со старым кодом */
export const boardSize = mapSize;

export const cellCenter = (map: GameMap, idx: number) => {
  const c = map.cells[idx];
  if (!c) return { x: 0, y: 0 };
  if (c.cx !== undefined && c.cy !== undefined) return { x: c.cx, y: c.cy };
  return { x: (c.x + (c.w || 1) / 2) * CELL, y: (c.y + (c.h || 1) / 2) * CELL };
};

/* Прямоугольник ячейки в пикселях поля (левый верхний угол + размер) */
export function cellBox(map: GameMap, idx: number) {
  const c = map.cells[idx];
  if (!c) return { x: 0, y: 0, w: CELL, h: CELL };
  if (c.cx !== undefined && c.cy !== undefined) {
    const w = c.cw ?? CELL, h = c.ch ?? CELL;
    return { x: c.cx - w / 2, y: c.cy - h / 2, w, h };
  }
  return { x: c.x * CELL, y: c.y * CELL, w: (c.w || 1) * CELL, h: (c.h || 1) * CELL };
}

/* Ячейка под точкой (координаты поля в px); возвращает индекс или -1 */
export function cellAtPoint(map: GameMap, wx: number, wy: number): number {
  for (let i = map.cells.length - 1; i >= 0; i--) {
    const b = cellBox(map, i);
    if (wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h) return i;
  }
  return -1;
}

/* ШТАМП под точкой: верхний — тот, что позже в массиве (рисуется последним) */
export function stampAtPoint(map: GameMap, wx: number, wy: number): number {
  const st = map.stamps ?? [];
  for (let i = st.length - 1; i >= 0; i--) {
    const s = st[i];
    if (wx >= s.x - s.w / 2 && wx < s.x + s.w / 2 && wy >= s.y - s.h / 2 && wy < s.y + s.h / 2) return i;
  }
  return -1;
}

/* ---------- маршрут: следующая/предыдущая ячейка ---------- */

/* Следующая ячейка маршрута: явная стрелка (cell.next), иначе автопорядок (i+1 по кругу) */
export function nextCellOf(map: GameMap, i: number): number {
  const N = map.cells.length;
  if (N === 0) return i;
  const nx = map.cells[i]?.next;
  if (nx !== undefined && nx !== i && nx >= 0 && nx < N) return nx;
  return (i + 1) % N;
}

/* Предыдущая ячейка: та, чья «следующая» — данная; иначе автопорядок назад */
export function prevCellOf(map: GameMap, i: number): number {
  const N = map.cells.length;
  if (N === 0) return i;
  for (let j = 0; j < N; j++) {
    if (j !== i && nextCellOf(map, j) === i) return j;
  }
  return (i - 1 + N) % N;
}

/* ---------- ЗАКОУЛОК ПО-НАСТОЯЩЕМУ (как в классических настольных играх) ----------
   · Ячейка может быть БЕЗ НОМЕРА (nonumber) — клетка круга/закоулка в стороне.
     Основной ход по номерам её ПЕРЕСКАКИВАЕТ (№3 → №8), попасть можно только по стрелке.
   · Стрелка (next) у БЕЗНОМЕРНОЙ ячейки — «дорога»: фишка ШАГАЕТ по ней кубиком.
     Стрелка у ПРОНУМЕРОВАННОЙ — прыжок: фишка, ОСТАНОВИВШАЯСЬ на ней, прыгает по стрелке.
   · ВТОРАЯ стрелка (hop, «ПЕРЕХОД») — прыжок при остановке с любой ячейки:
     выход из круга на №8, штраф-телепорт. Проходом мимо — не срабатывает.
   Остановился → прыгнул → выполняет ячейку, на которой стоит. Один прыжок за остановку. */

const isNoNum = (c: CellDef): boolean => !!c.nonumber || c.n === 0; // n=0 — старые карты закоулков v0.12.x

/* Цель прыжка при ОСТАНОВКЕ на ячейке: вторая стрелка hop, а у пронумерованной —
   и обычная стрелка next (это и есть «вход» в круг / штраф-стрелка).
   Нет прыжка — возвращается та же ячейка. */
export function hopTargetOf(map: GameMap, i: number): number {
  const N = map.cells.length;
  const c = map.cells[i];
  if (!c || N === 0) return i;
  const legacy = (c as CellDef & { nextTag?: 'in' | 'out' }).nextTag;
  let raw = c.hop;
  if (raw === undefined && !isNoNum(c) && legacy !== 'out' && c.next !== undefined) raw = c.next;
  if (raw === undefined || raw < 0 || raw >= N || raw === i) return i;
  return raw;
}

/* Шаг фишки ВПЕРЁД:
   · пронумерованная ячейка → следующая ПРОНУМЕРОВАННАЯ по порядку (безномерные перескакиваются);
   · безномерная → по своей стрелке-дороге (нет стрелки — стоит на месте). */
export function stepNext(map: GameMap, i: number): number {
  const N = map.cells.length;
  if (N === 0) return i;
  const c = map.cells[i];
  if (!c) return i;
  if (isNoNum(c)) {
    const j = c.next;
    return j !== undefined && j >= 0 && j < N && j !== i ? j : i;
  }
  for (let k = 1; k <= N; k++) {
    const j = (i + k) % N;
    if (!isNoNum(map.cells[j])) return j;
  }
  return i;
}

/* Шаг фишки НАЗАД:
   · пронумерованная → предыдущая ПРОНУМЕРОВАННАЯ по порядку;
   · безномерная → против дороги (та ячейка, чья стрелка ведёт сюда; нет — стоит). */
export function stepPrev(map: GameMap, i: number): number {
  const N = map.cells.length;
  if (N === 0) return i;
  const c = map.cells[i];
  if (!c) return i;
  if (isNoNum(c)) {
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      if (map.cells[j].next !== undefined && map.cells[j].next === i) return j;
    }
    return i;
  }
  for (let k = 1; k <= N; k++) {
    const j = (i - k + N + N) % N;
    if (!isNoNum(map.cells[j])) return j;
  }
  return i;
}

/* Стартовая ячейка: первая с типом «старт», иначе №0 */
export const startCellIdx = (map: GameMap): number => {
  const i = map.cells.findIndex((c) => c.type === 'start');
  return i >= 0 ? i : 0;
};

/* Нумерация ПО ПОРЯДКУ СОЗДАНИЯ: ячейка №1 — первая поставленная и т.д.
   Кнопка «Без номера» лишь прячет номер и выводит клетку из основного пути —
   номера ОСТАЛЬНЫХ ячеек НЕ сдвигаются (№8 остаётся №8). */
export function renumberByPath(map: GameMap): void {
  for (let i = 0; i < map.cells.length; i++) map.cells[i].n = i + 1;
}

/* Разовая конвертация старых карт (метки «вход/выход» v0.12.x) в новую модель:
   клетки с n=0 → без номера; у «выхода» дорога наружу больше не нужна;
   метки стираются (стрелка «входа» и так прыжок у пронумерованной ячейки). */
export function normCellsLegacy(map: GameMap): void {
  for (const c of map.cells) {
    if (c.n === 0 && !c.nonumber) c.nonumber = true;
    const legacy = (c as CellDef & { nextTag?: 'in' | 'out' }).nextTag;
    if (legacy === 'out' && c.next !== undefined && c.hop === undefined) delete c.next;
    delete (c as CellDef & { nextTag?: 'in' | 'out' }).nextTag;
  }
  renumberByPath(map);
}

/* После УДАЛЕНИЯ ячейки: чистим/сдвигаем явные стрелки и прыжки (индексы съехали) и перенумеровываем */
export function fixLinksAfterDelete(map: GameMap, deletedIdx: number): void {
  const N = map.cells.length;
  for (let i = 0; i < N; i++) {
    const c = map.cells[i];
    if (c.next !== undefined) {
      if (c.next === deletedIdx) { delete c.next; delete (c as CellDef & { nextTag?: 'in' | 'out' }).nextTag; }
      else if (c.next > deletedIdx) c.next--;
      if (c.next !== undefined && (c.next < 0 || c.next >= N || c.next === i)) { delete c.next; delete (c as CellDef & { nextTag?: 'in' | 'out' }).nextTag; }
    }
    if (c.hop !== undefined) {
      if (c.hop === deletedIdx) delete c.hop;
      else if (c.hop > deletedIdx) c.hop--;
      if (c.hop !== undefined && (c.hop < 0 || c.hop >= N || c.hop === i)) delete c.hop;
    }
  }
  renumberByPath(map);
}

export function fitView(map: GameMap, w: number, h: number) {
  const b = mapSize(map);
  const zoom = Math.min(w / (b.w + 120), h / (b.h + 120));
  return { x: b.w / 2, y: b.h / 2, zoom: Math.max(0.2, zoom) };
}

export interface TokenDraw {
  x: number; y: number;
  color: string;
  active: boolean;
  alive: boolean;
  label: string;
  img?: string | null; // dataUrl кастомной фишки (PNG с прозрачностью)
}

export interface BoardDrawOpts {
  view: { x: number; y: number; zoom: number };
  width: number; height: number;
  tileById: Map<string, TileDef>;
  captured: Record<number, string>;
  colorById: Record<string, string>;
  currentCell: number | null;
  showNumbers: boolean;
  tokens: TokenDraw[];
  time: number;
  hoverCell: number | null;
  mystery?: Set<number>; // ячейки, которые ещё не «открыты» — рисуем как «?»
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, pattern: string[], color: string) {
  ctx.fillStyle = color;
  for (let r = 0; r < pattern.length; r++) {
    for (let c = 0; c < pattern[r].length; c++) {
      if (pattern[r][c] === '1') ctx.fillRect(x + c * s, y + r * s, s, s);
    }
  }
}

const STAR = ['..1..', '.111.', '11111', '.111.', '1.1.1'];
const SKULL = ['.111.', '11111', '10101', '11111', '.1.1.'];
const PAD = ['.111.', '11111', '11111', '.111.'];
const QUIZ = ['.111.', '1..11', '..11.', '..1..', '.....', '..1..'];
const FLAG = ['1....', '1111.', '11111', '1111.', '1....'];
const flagIcon = (ctx: CanvasRenderingContext2D, s: number, color: string) => {
  px(ctx, -2 * s, -2.5 * s, s, FLAG, color);
};

function tilesetMap(map: GameMap): Map<string, TileImg> {
  return new Map((map.tileset ?? []).map((t) => [t.id, t]));
}

export function drawBoard(ctx: CanvasRenderingContext2D, map: GameMap, o: BoardDrawOpts) {
  const { view, width, height } = o;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0e1c';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(-view.x, -view.y);

  const b = mapSize(map);
  // подложка карты
  ctx.fillStyle = '#10142a';
  ctx.fillRect(-24, -24, b.w + 48, b.h + 48);
  ctx.strokeStyle = '#313c72';
  ctx.lineWidth = 6;
  ctx.strokeRect(-24, -24, b.w + 48, b.h + 48);
  ctx.strokeStyle = 'rgba(74,88,168,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(-12, -12, b.w + 24, b.h + 24);

  // ОБЩИЙ ФОН КАРТЫ (редактор в стиле Tiled): растянут на поле или 1:1
  if (map.bg) {
    const img = getImage(map.bg);
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, b.w, b.h);
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      if (map.bgMode === 'real') ctx.drawImage(img, 0, 0);
      else ctx.drawImage(img, 0, 0, b.w, b.h);
      ctx.restore();
    }
  }

  // СТАРЫЙ формат тайлов (глобальная библиотека) — только пока карта не переехала в штампы
  if (map.tiles.length > 0 && !(map.stamps && map.stamps.length)) {
    for (const pt of map.tiles) {
      const tile = o.tileById.get(pt.tileId);
      if (!tile) continue;
      const img = getImage(tile.dataUrl);
      const cx = (pt.x + tile.gw / 2) * CELL;
      const cy = (pt.y + tile.gh / 2) * CELL;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((pt.rot * Math.PI) / 2);
      const w = tile.gw * CELL;
      const h = tile.gh * CELL;
      if (img) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
      } else {
        ctx.fillStyle = '#1a2244';
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.restore();
    }
  }

  // ШТАМПЫ (тайлы редактора в стиле Tiled): порядок в массиве = слой, последние сверху
  const tset = tilesetMap(map);
  const stamps = map.stamps ?? [];
  for (const st of stamps) {
    const t = tset.get(st.tid);
    const img = t ? getImage(t.dataUrl) : null;
    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate((st.rot * Math.PI) / 2);
    if (img) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, -st.w / 2, -st.h / 2, st.w, st.h);
    } else {
      ctx.fillStyle = 'rgba(26,34,68,0.8)';
      ctx.fillRect(-st.w / 2, -st.h / 2, st.w, st.h);
      ctx.strokeStyle = '#ff5d73';
      ctx.lineWidth = 2;
      ctx.strokeRect(-st.w / 2, -st.h / 2, st.w, st.h);
    }
    ctx.restore();
  }

  // сетка — только на картах без фона (поверх картинки она мешает)
  if (!map.bg) {
    ctx.strokeStyle = 'rgba(49,60,114,0.28)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= b.w; x += CELL) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, b.h); ctx.stroke();
    }
    for (let y = 0; y <= b.h; y += CELL) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(b.w, y); ctx.stroke();
    }
  }

  const N = map.cells.length;
  if (N > 1) {
    // Стрелки: ЗОЛОТАЯ — явная «дорога» (у безномерной — куда шагает фишка, у
    // пронумерованной — прыжок при остановке); белый ПУНКТИР — авто-порядок у
    // пронумерованных; КОРАЛЛОВАЯ с подписью «ПЕРЕХОД» — вторая стрелка-прыжок.
    // Старые метки закоулков («вход»/«выход») подсвечиваются голубым/зелёным.
    const TAG_STYLES: Record<string, { c: string; h: string; label: string }> = {
      in: { c: '#5aa9ff', h: '#7bbcff', label: 'ВХОД' },
      out: { c: '#2ee6a8', h: '#5ff0bf', label: 'ВЫХОД' },
    };
    const GOLD = 'rgba(255,207,63,0.85)', GOLD_H = 'rgba(255,207,63,0.95)';
    const AUTO = 'rgba(233,236,255,0.35)', AUTO_H = 'rgba(233,236,255,0.55)';
    const HOP = '#ff6b6b', HOP_H = '#ff9b9b';
    const seg = (ai: number, bi: number, col: string, head: string, dashed: boolean, label?: string) => {
      const a = cellCenter(map, ai);
      const c = cellCenter(map, bi);
      const dx = c.x - a.x, dy = c.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      if (len < 8) return;
      const ux = dx / len, uy = dy / len;
      const ba = cellBox(map, ai);
      const bb = cellBox(map, bi);
      const padA = Math.min(ba.w, ba.h) * 0.32 + 6;
      const padB = Math.min(bb.w, bb.h) * 0.32 + 6;
      const sx = a.x + ux * padA, sy = a.y + uy * padA;
      const ex = c.x - ux * padB, ey = c.y - uy * padB;
      ctx.strokeStyle = col;
      ctx.lineWidth = dashed ? 3 : 3.5;
      if (dashed) ctx.setLineDash([7, 7]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      if (dashed) ctx.setLineDash([]);
      ctx.fillStyle = head;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - ux * 11 - uy * 6.5, ey - uy * 11 + ux * 6.5);
      ctx.lineTo(ex - ux * 11 + uy * 6.5, ey - uy * 11 - ux * 6.5);
      ctx.fill();
      // подпись у середины стрелки (чуть сбоку, чтобы не сливалась с линией)
      if (label) {
        const mx = (sx + ex) / 2 - uy * 13;
        const my = (sy + ey) / 2 + ux * 13;
        ctx.fillStyle = 'rgba(7,9,18,0.8)';
        const tw = label.length * 6 + 6;
        ctx.fillRect(mx - tw / 2, my - 7, tw, 12);
        ctx.fillStyle = col;
        ctx.font = '7px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, mx, my + 2);
      }
    };
    for (let i = 0; i < N; i++) {
      const ci = map.cells[i];
      const legacyTag = (ci as CellDef & { nextTag?: 'in' | 'out' }).nextTag;
      const nxt = ci.next;
      if (nxt !== undefined && nxt >= 0 && nxt < N && nxt !== i) {
        const st = legacyTag ? TAG_STYLES[legacyTag] : null;
        seg(i, nxt, st ? st.c : GOLD, st ? st.h : GOLD_H, false, st ? st.label : undefined);
      } else if (!isNoNum(ci)) {
        seg(i, (i + 1) % N, AUTO, AUTO_H, true); // авто-порядок у пронумерованных
      }
      const h = ci.hop;
      if (h !== undefined && h >= 0 && h < N && h !== i) seg(i, h, HOP, HOP_H, false, 'ПЕРЕХОД');
    }
  }

  // ячейки
  for (let i = 0; i < N; i++) {
    const cell = map.cells[i];
    const { x: cx, y: cy } = cellCenter(map, i);
    const box = cellBox(map, i);
    const owner = o.captured[i];
    const isCur = o.currentCell === i;
    const isMystery = !!o.mystery?.has(i);
    const isStart = cell.type === 'start';
    // малая ячейка (до 68px) рисуется схематично фиксированным размером, крупная — во всю площадь
    const small = box.w <= 68 && box.h <= 68;
    const pulse = isCur ? 1 + Math.sin(o.time / 160) * 0.05 : 1;
    const big = !small;
    const W = (small ? Math.min(44, box.w) : box.w - 6) * pulse;
    const H = (small ? Math.min(44, box.h) : box.h - 6) * pulse;

    ctx.save();
    ctx.translate(cx, cy);

    if (isCur) {
      ctx.strokeStyle = '#ffcf3f';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -o.time / 40;
      ctx.strokeRect(-W / 2 - 5, -H / 2 - 5, W + 10, H + 10);
      ctx.setLineDash([]);
    }

    if (isMystery) {
      // закрытая ячейка: тёмный фон, знак «?», без подсказок о типе
      ctx.fillStyle = '#141833';
      ctx.fillRect(-W / 2, -H / 2, W, H);
      ctx.strokeStyle = '#313c72';
      ctx.lineWidth = 3;
      ctx.strokeRect(-W / 2, -H / 2, W, H);
      ctx.fillStyle = '#5a628f';
      ctx.font = `${big ? 20 : 15}px "Press Start 2P", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('?', 0, big ? 8 : 6);
      if (o.showNumbers && cell.n > 0 && !cell.nonumber) {
        ctx.fillStyle = '#8f97c9';
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.fillText(String(cell.n), 0, H / 2 - 6);
      }
      ctx.restore();
      continue;
    }

    const base = isStart ? '#12351f'
      : cell.type === 'bonus' ? '#0d3f2e' : cell.type === 'trap' ? '#43101c' : '#232741';
    const edge = cell.color || (isStart ? '#ffcf3f'
      : cell.type === 'bonus' ? '#2ee6a8' : cell.type === 'trap' ? '#ff5d73' : '#8f97c9');
    ctx.fillStyle = base;
    ctx.fillRect(-W / 2, -H / 2, W, H);

    if (big) {
      /* ---------- крупная ячейка «улица монополии» ---------- */
      if (cell.color) {
        ctx.fillStyle = cell.color;
        ctx.fillRect(-W / 2, -H / 2, W, 15);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(-W / 2, -H / 2 + 15, W, 3);
      }
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      ctx.strokeRect(-W / 2, -H / 2, W, H);

      if (isStart) {
        // стартовая ячейка: флаг и подпись
        flagIcon(ctx, Math.min(6, Math.max(3, W / 12)), '#ffcf3f');
        ctx.fillStyle = '#ffcf3f';
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('СТАРТ', 0, H / 2 - 8);
      } else if (cell.type === 'task') {
        const imgSrc = cell.task?.imageId || cell.imageId;
        const img = imgSrc ? getImage(imgSrc) : null;
        const areaTop = -H / 2 + (cell.color ? 20 : 5);
        const areaH = H - (cell.color ? 20 : 5) - 16;
        if (img) {
          ctx.imageSmoothingEnabled = false;
          const iw = img.width || 1, ih = img.height || 1;
          const sc = Math.max((W - 10) / iw, areaH / ih);
          const dw = iw * sc, dh = ih * sc;
          ctx.save();
          ctx.beginPath();
          ctx.rect(-W / 2 + 4, areaTop, W - 8, areaH);
          ctx.clip();
          ctx.drawImage(img, -dw / 2, areaTop + (areaH - dh) / 2, dw, dh);
          ctx.restore();
        }
        const title = (cell.label || cell.task?.title || '').toUpperCase();
        if (title && W >= CELL * 1.6) {
          ctx.fillStyle = 'rgba(7,9,18,0.75)';
          ctx.fillRect(-W / 2 + 3, H / 2 - 15, W - 6, 12);
          ctx.fillStyle = '#e9ecff';
          ctx.font = '7px "Press Start 2P", monospace';
          ctx.textAlign = 'center';
          const maxChars = Math.floor((W - 12) / 7);
          ctx.fillText(title.slice(0, maxChars), 0, H / 2 - 6);
        }
        if (!cell.task) {
          ctx.fillStyle = 'rgba(255,139,63,0.95)';
          ctx.font = '10px "Press Start 2P", monospace';
          ctx.textAlign = 'center';
          ctx.fillText('!', W / 2 - 9, -H / 2 + (cell.color ? 30 : 16));
        }
      } else {
        const icon = cell.type === 'bonus' ? STAR : cell.type === 'trap' ? SKULL : QUIZ;
        const iconColor = cell.type === 'bonus' ? '#2ee6a8' : cell.type === 'trap' ? '#ff5d73' : '#5aa9ff';
        const cimg = cell.imageId ? getImage(cell.imageId) : null;
        if (cimg) {
          // картинка на бонусе/ловушке/квизе — как на заданиях; иконка типа в углу, чтобы ячейка читалась
          const areaTop2 = -H / 2 + (cell.color ? 20 : 5);
          const areaH2 = H - (cell.color ? 20 : 5) - 16;
          ctx.imageSmoothingEnabled = false;
          const iw = cimg.width || 1, ih = cimg.height || 1;
          const sc = Math.max((W - 10) / iw, areaH2 / ih);
          const dw = iw * sc, dh = ih * sc;
          ctx.save();
          ctx.beginPath();
          ctx.rect(-W / 2 + 4, areaTop2, W - 8, areaH2);
          ctx.clip();
          ctx.drawImage(cimg, -dw / 2, areaTop2 + (areaH2 - dh) / 2, dw, dh);
          ctx.restore();
          const icw = icon[0].length * 2 + 6;
          ctx.fillStyle = 'rgba(7,9,18,0.72)';
          ctx.fillRect(-W / 2 + 4, areaTop2 + 2, icw, 12);
          px(ctx, -W / 2 + 7, areaTop2 + 4, 2, icon, iconColor);
        } else {
          px(ctx, -icon[0].length * 3, -H / 2 + (cell.color ? 24 : 12), 6, icon, iconColor);
        }
        ctx.fillStyle = '#e9ecff';
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        const name = cell.label || (cell.type === 'bonus' ? 'БОНУС' : cell.type === 'trap' ? 'ЛОВУШКА' : 'КВИЗ');
        ctx.fillText(name.slice(0, Math.floor((W - 10) / 8)).toUpperCase(), 0, H / 2 - 8);
      }
      if (o.showNumbers && cell.n > 0 && !cell.nonumber) {
        ctx.fillStyle = '#e9ecff';
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(String(cell.n), -W / 2 + 6, H / 2 - 6);
      }
    } else {
      /* ---------- малая ячейка (схематичная) ---------- */
      if (cell.color) {
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = cell.color;
        ctx.fillRect(-W / 2, -H / 2, W, H);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      ctx.strokeRect(-W / 2, -H / 2, W, H);
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 2;
      ctx.strokeRect(-W / 2 + 3, -H / 2 + 3, W - 6, H - 6);

      const cellImg = cell.imageId ? getImage(cell.imageId) : null;
      if (isStart) {
        flagIcon(ctx, 4, '#ffcf3f');
      } else if (cellImg) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cellImg, -11, -13, 22, 22);
      } else {
        const icon = cell.type === 'bonus' ? STAR : cell.type === 'trap' ? SKULL : cell.type === 'quiz' ? QUIZ : PAD;
        const iconColor = cell.type === 'task' ? '#ffcf3f' : cell.type === 'quiz' ? '#5aa9ff' : edge;
        px(ctx, -icon[0].length * 2, -14, 4, icon, iconColor);
      }
      if (cell.label) {
        ctx.fillStyle = '#e9ecff';
        ctx.font = '7px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(cell.label.slice(0, 9).toUpperCase(), 0, 8);
      }
      if (cell.type === 'task' && !cell.task) {
        ctx.strokeStyle = 'rgba(255,139,63,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-W / 2 + 6, H / 2 - 6);
        ctx.lineTo(W / 2 - 6, H / 2 - 6);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,139,63,0.95)';
        ctx.font = '9px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('!', W / 2 - 8, -H / 2 + 14);
      }
      if (o.showNumbers && cell.n > 0 && !cell.nonumber) {
        ctx.fillStyle = '#e9ecff';
        ctx.font = '9px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(cell.n), 0, 17);
      }
    }

    if (owner && o.colorById[owner]) {
      ctx.fillStyle = o.colorById[owner];
      ctx.beginPath();
      ctx.moveTo(-W / 2, -H / 2);
      ctx.lineTo(-W / 2 + 18, -H / 2);
      ctx.lineTo(-W / 2, -H / 2 + 18);
      ctx.fill();
      ctx.strokeStyle = o.colorById[owner];
      ctx.lineWidth = 3;
      ctx.strokeRect(-W / 2 - 3, -H / 2 - 3, W + 6, H + 6);
    }
    if (o.hoverCell === i) {
      ctx.strokeStyle = '#ffcf3f';
      ctx.lineWidth = 2;
      ctx.strokeRect(-W / 2 - 6, -H / 2 - 6, W + 12, H + 12);
    }
    ctx.restore();
  }

  // флаг старта — над стартовой ячейкой (или над первой, если старой разметки нет)
  if (N > 0) {
    const c0 = cellCenter(map, startCellIdx(map));
    ctx.save();
    ctx.translate(c0.x + 20, c0.y - 34);
    ctx.fillStyle = '#e9ecff';
    ctx.fillRect(0, 0, 3, 26);
    ctx.fillStyle = '#ffcf3f';
    ctx.beginPath(); ctx.moveTo(3, 0); ctx.lineTo(22, 5); ctx.lineTo(3, 11); ctx.fill();
    ctx.restore();
  }

  // токены
  for (let i = 0; i < o.tokens.length; i++) {
    const t = o.tokens[i];
    ctx.save();
    ctx.translate(t.x, t.y);
    const bob = t.active ? Math.sin(o.time / 140 + i) * 2.5 : 0;
    ctx.translate(0, bob - 6);
    const s = t.active ? 1.12 : 1;
    ctx.scale(s, s);
    ctx.globalAlpha = t.alive ? 1 : 0.35;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(0, 16 - bob / s, 11, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();

    const custom = t.img ? getImage(t.img) : null;
    if (custom) {
      ctx.imageSmoothingEnabled = false;
      const sz = 34;
      ctx.drawImage(custom, -sz / 2, -sz / 2 - 4, sz, sz);
      if (t.active) {
        ctx.strokeStyle = '#ffcf3f';
        ctx.lineWidth = 2;
        ctx.strokeRect(-sz / 2 - 3, -sz / 2 - 7, sz + 6, sz + 6);
      }
    } else {
      const body = t.alive ? t.color : '#5a628f';
      ctx.fillStyle = body;
      ctx.fillRect(-9, -12, 18, 22);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(-9, -12, 18, 5);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-9, 5, 18, 5);
      ctx.fillStyle = '#0a0c18';
      ctx.fillRect(-6, -6, 4, 6);
      ctx.fillRect(2, -6, 4, 6);
      ctx.fillStyle = '#e9ecff';
      ctx.fillRect(-6, -6, 2, 2);
      ctx.fillRect(2, -6, 2, 2);
      ctx.fillStyle = body;
      ctx.fillRect(-1, -18, 2, 6);
      ctx.fillRect(-3, -21, 6, 4);
      if (t.active) {
        ctx.strokeStyle = '#ffcf3f';
        ctx.lineWidth = 2;
        ctx.strokeRect(-13, -24, 26, 36);
      }
    }
    ctx.restore();
  }

  ctx.restore();
}
