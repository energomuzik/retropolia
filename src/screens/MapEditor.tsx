import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { GhostBtn, Ic, Modal, PxBtn, Stepper } from '../ui';
import {
  CELL, mapSize, drawBoard, fitView, cellAtPoint, stampAtPoint, cellBox, cellCenter,
  renumberByPath, normCellsLegacy, fixLinksAfterDelete, startCellIdx,
} from '../render';
import { idbDel, idbPut, uid } from '../db';
import type { CellDef, CellType, GameMap, Stamp, TokenDef, TileGroup, TileImg } from '../types';
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

/* ---------- ЭКСТРАКТОР ТАЙЛОВ: нарезка спрайт-листов с однотонным фоном ----------
   Ядро портировано из проверенного отдельного экстрактора (работает на листах
   вида mariouniverse). Ключевые отличия от прошлой версии:
   1) пятна ищутся по РАЗДУТОЙ маске (dilate), а не по пересечению раздутых
      РАМОК — раньше близкие в ряд спрайты сливались всей строкой;
   2) плашки: почти цельное пятно одного цвета (чёрный/белый квадрат) —
      содержимое вырезается изнутри заливкой цвета плашки от краёв;
   3) мелкий ч/б текст (подписи на листе) выбрасывается (можно оставить);
   4) сортировка результата строками, как глазами по листу. */

export interface ExtractParams {
  bgMode: 'auto' | 'custom';
  bg: string;       // цвет фона при bgMode='custom' (#rrggbb)
  thr: number;      // допуск: |ΔR|+|ΔG|+|ΔB| больше → передний план (0..200)
  minSize: number;  // минимальная сторона тайла, px
  mergeGap: number; // склейка частей: раздувание маски, px (0 = выкл)
  keepText: boolean;// оставить мелкий ч/б текст (подписи на листе)
}

export interface ExtractInfo { W: number; H: number; data: Uint8ClampedArray }

interface ExTile { x: number; y: number; w: number; h: number; mask: Uint8Array }
interface ExComp { id: number; x0: number; y0: number; x1: number; y1: number; count: number } // x1/y1 не вкл.

/* раздувание маски на it пикселей: части одного тайла через щель ≤ 2·it сливаются,
   а спрайты на большем расстоянии остаются раздельными */
function dilateMask(mask: Uint8Array, w: number, h: number, it: number): Uint8Array {
  let m = mask;
  for (let t = 0; t < it; t++) {
    const m2 = m.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (m[p]) {
          if (y > 0) m2[p - w] = 1;
          if (y < h - 1) m2[p + w] = 1;
          if (x > 0) m2[p - 1] = 1;
          if (x < w - 1) m2[p + 1] = 1;
        }
      }
    }
    m = m2;
  }
  return m;
}

/* 8-связные компоненты маски */
function labelComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; comps: ExComp[] } {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let n = 0;
  const comps: ExComp[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    n++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = n;
    let y0 = h, y1 = 0, x0 = w, x1 = 0, cnt = 0;
    while (sp) {
      const p = stack[--sp];
      cnt++;
      const py = (p / w) | 0, px = p % w;
      if (py < y0) y0 = py;
      if (py + 1 > y1) y1 = py + 1;
      if (px < x0) x0 = px;
      if (px + 1 > x1) x1 = px + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) { labels[q] = n; stack[sp++] = q; }
        }
      }
    }
    comps.push({ id: n, x0, y0, x1, y1, count: cnt });
  }
  return { labels, comps };
}

/* заливка цветных пикселей от краёв окна: что достижимо снаружи — внешность плашки */
function floodBorder(mask: Uint8Array, w: number, h: number): Uint8Array {
  const vis = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (x: number, y: number) => { const p = y * w + x; if (mask[p] && !vis[p]) { vis[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (stack.length) {
    const p = stack.pop()!;
    const py = (p / w) | 0, px = p % w;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = py + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx;
        if (nx < 0 || nx >= w) continue;
        const q = ny * w + nx;
        if (mask[q] && !vis[q]) { vis[q] = 1; stack.push(q); }
      }
    }
  }
  return vis;
}

/* мелкий ч/б текст: строка из ≥3 маленьких серых пятнышек подряд = подпись, долой */
function textFilter(tiles: ExTile[], data: Uint8ClampedArray, W: number): ExTile[] {
  const gray = (t: ExTile): boolean => {
    let n = 0, g = 0;
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) {
        if (!t.mask[y * t.w + x]) continue;
        n++;
        const s = ((t.y + y) * W + (t.x + x)) * 4;
        const mx = Math.max(data[s], data[s + 1], data[s + 2]);
        const mn = Math.min(data[s], data[s + 1], data[s + 2]);
        if (mx - mn <= 30) g++;
      }
    }
    return n > 0 && g / n > 0.9;
  };
  const cand = tiles.filter((t) => t.h <= 16 && t.w <= 16 && gray(t)).sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: ExTile[][] = [];
  let cur: ExTile[] = [];
  for (const t of cand) {
    const last = cur[cur.length - 1];
    if (last && Math.abs(t.y - cur[0].y) <= 4 && t.x - (last.x + last.w) <= 12) cur.push(t);
    else { if (cur.length) groups.push(cur); cur = [t]; }
  }
  if (cur.length) groups.push(cur);
  const drop = new Set<ExTile>();
  for (const gr of groups) if (gr.length >= 3) gr.forEach((t) => drop.add(t));
  return tiles.filter((t) => !drop.has(t));
}

/* сортировка «как на листе»: строки сверху вниз, внутри строки слева направо */
function sortReadingOrder(tiles: ExTile[]): ExTile[] {
  const sorted = [...tiles].sort((a, b) => a.y - b.y);
  const rows: { bottom: number; items: ExTile[] }[] = [];
  for (const t of sorted) {
    const r = rows[rows.length - 1];
    if (r && t.y < r.bottom) { r.items.push(t); r.bottom = Math.max(r.bottom, t.y + t.h); }
    else rows.push({ bottom: t.y + t.h, items: [t] });
  }
  const res: ExTile[] = [];
  for (const r of rows) { r.items.sort((a, b) => a.x - b.x); res.push(...r.items); }
  return res;
}

async function extractTilesFromImage(file: File, p: ExtractParams, infoRef?: { current: ExtractInfo | null }): Promise<{ tiles: TileImg[]; bg: string; hasAlpha: boolean }> {
  const url0 = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url0;
    });
    const k = Math.min(1, 1400 / Math.max(img.width || 1, img.height || 1));
    const W = Math.max(1, Math.round(img.width * k));
    const H = Math.max(1, Math.round(img.height * k));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    cx.drawImage(img, 0, 0, W, H);
    const data = cx.getImageData(0, 0, W, H).data;
    if (infoRef) infoRef.current = { W, H, data };
    const N = W * H;

    // 1) прозрачность: если много прозрачных пикселей — фон уже прозрачный
    let transp = 0;
    for (let q = 0; q < N; q++) if (data[q * 4 + 3] < 128) transp++;
    const hasAlpha = transp > N * 0.25;

    // 2) цвет фона: АВТО = самый частый цвет ВСЕЙ картинки (квантование 5 бит/канал —
    //    шум JPEG не дробит цвет); или выбранный пользователем (пипетка/палитра)
    let foundBg = '';
    let br = 0, bgc = 0, bb = 0;
    if (p.bgMode === 'custom') {
      const h = p.bg.replace('#', '');
      br = parseInt(h.slice(0, 2), 16) || 0;
      bgc = parseInt(h.slice(2, 4), 16) || 0;
      bb = parseInt(h.slice(4, 6), 16) || 0;
      foundBg = p.bg;
    } else {
      const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
      for (let q = 0; q < N; q++) {
        const i = q * 4;
        if (data[i + 3] < 128) continue;
        const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        const b = buckets.get(key);
        if (b) { b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; b.n++; }
        else buckets.set(key, { r: data[i], g: data[i + 1], b: data[i + 2], n: 1 });
      }
      const list = Array.from(buckets.values());
      if (!list.length) return { tiles: [], bg: '#000000', hasAlpha };
      list.sort((a, b) => b.n - a.n);
      br = Math.round(list[0].r / list[0].n); bgc = Math.round(list[0].g / list[0].n); bb = Math.round(list[0].b / list[0].n);
      const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
      foundBg = `#${hex(br)}${hex(bgc)}${hex(bb)}`;
    }
    const bgK = (br << 16) | (bgc << 8) | bb;
    const tol = p.thr;

    // 3) маска переднего плана: НЕ прозрачный И НЕ близкий к фону
    //    (допуск — сумма |ΔR|+|ΔG|+|ΔB|, как в проверенном отдельном экстракторе)
    const fg = new Uint8Array(N);
    for (let q = 0; q < N; q++) {
      const i = q * 4;
      if (data[i + 3] < 128) continue;
      if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgc) + Math.abs(data[i + 2] - bb) > tol) fg[q] = 1;
    }

    // 4) пятна ищем по РАЗДУТОЙ маске (склейка частей через щель работает по
    //    ПИКСЕЛЯМ, а не по рамкам — поэтому близкие в ряд спрайты НЕ сливаются)
    const { labels, comps } = labelComponents(dilateMask(fg, W, H, p.mergeGap), W, H);

    const min = Math.max(1, p.minSize);
    const found: ExTile[] = [];

    for (const c of comps) {
      const w = c.x1 - c.x0, h = c.y1 - c.y0;
      if (w < min || h < min) continue;
      const fill = c.count / (w * h);
      if (fill < 0.1 && Math.max(w, h) > 80) continue; // тонкие рамки/линии

      // цветовая гистограмма пятна → доминирующий цвет (ищем плашки)
      const compO = new Uint8Array(w * h);
      const colCnt = new Map<number, number>();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const pp = (c.y0 + y) * W + (c.x0 + x);
          if (labels[pp] !== c.id) continue;
          if (fg[pp]) compO[y * w + x] = 1;
          const s = pp * 4;
          const kk = (data[s] << 16) | (data[s + 1] << 8) | data[s + 2];
          colCnt.set(kk, (colCnt.get(kk) || 0) + 1);
        }
      }
      let domK = 0, domM = -1;
      colCnt.forEach((v, kk) => { if (v > domM) { domM = v; domK = kk; } });

      // ПЛАШКА: пятно почти целиком залито одним цветом (≠ фону) — чёрный/белый
      // квадрат с содержимым. Содержимое вырезаем изнутри: цвет плашки заливаем
      // от краёв bbox, всё недостижимое И не-фон — содержимое.
      const localBg = fill > 0.5 && domM / c.count > 0.7 && domK !== bgK ? domK : null;

      if (localBg === null) { found.push({ x: c.x0, y: c.y0, w, h, mask: compO }); continue; }

      const lr = (localBg >> 16) & 255, lg = (localBg >> 8) & 255, lb2 = localBg & 255;
      const lb = new Uint8Array(w * h), gb = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = ((c.y0 + y) * W + (c.x0 + x)) * 4;
          if (Math.abs(data[s] - lr) + Math.abs(data[s + 1] - lg) + Math.abs(data[s + 2] - lb2) <= tol) lb[y * w + x] = 1;
          if (Math.abs(data[s] - br) + Math.abs(data[s + 1] - bgc) + Math.abs(data[s + 2] - bb) <= tol) gb[y * w + x] = 1;
        }
      }
      const outer = floodBorder(lb, w, h);
      const content = new Uint8Array(w * h);
      for (let q = 0; q < content.length; q++) if (!outer[q] && !gb[q]) content[q] = 1;

      const sl = labelComponents(dilateMask(content, w, h, p.mergeGap), w, h);
      let pushed = 0;
      for (const sc of sl.comps) {
        const sw = sc.x1 - sc.x0, sh = sc.y1 - sc.y0;
        if (sw < min || sh < min) continue;
        if (sc.count / (sw * sh) < 0.1 && Math.max(sw, sh) > 80) continue;
        const m = new Uint8Array(sw * sh);
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            const q = (sc.y0 + y) * w + (sc.x0 + x);
            if (sl.labels[q] === sc.id && content[q]) m[y * sw + x] = 1;
          }
        }
        found.push({ x: c.x0 + sc.x0, y: c.y0 + sc.y0, w: sw, h: sh, mask: m });
        pushed++;
      }
      // внутри плашки не нашлось содержимого (монолит одного цвета) — берём её целиком
      if (!pushed) found.push({ x: c.x0, y: c.y0, w, h, mask: compO });
    }
    if (!found.length) return { tiles: [], bg: foundBg, hasAlpha };

    // 5) мелкий ч/б текст (подписи на листе) выбрасываем — если не попросили оставить
    const kept = p.keepText ? found : textFilter(found, data, W);

    // 6) сортировка «как на листе» (строками) + потолок количества
    const ordered = sortReadingOrder(kept).slice(0, 200);
    if (!ordered.length) return { tiles: [], bg: foundBg, hasAlpha };

    // 7) вырезаем каждый тайл в PNG с прозрачным фоном; маску обрезаем ТУГО
    //    (убираем прозрачные поля, оставшиеся от раздувания маски)
    const out: TileImg[] = [];
    ordered.forEach((t, ci) => {
      let bx0 = t.w, by0 = t.h, bx1 = -1, by1 = -1;
      for (let y = 0; y < t.h; y++) {
        for (let x = 0; x < t.w; x++) {
          if (!t.mask[y * t.w + x]) continue;
          if (x < bx0) bx0 = x;
          if (y < by0) by0 = y;
          if (x > bx1) bx1 = x;
          if (y > by1) by1 = y;
        }
      }
      if (bx1 < 0) return;
      const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
      const ox = t.x + bx0, oy = t.y + by0; // тугой bbox в координатах листа
      const tcv = document.createElement('canvas');
      tcv.width = w; tcv.height = h;
      const tcx = tcv.getContext('2d')!;
      const timg = tcx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!t.mask[(by0 + y) * t.w + (bx0 + x)]) continue;
          const si = ((oy + y) * W + (ox + x)) * 4, di = (y * w + x) * 4;
          timg.data[di] = data[si];
          timg.data[di + 1] = data[si + 1];
          timg.data[di + 2] = data[si + 2];
          timg.data[di + 3] = 255;
        }
      }
      tcx.putImageData(timg, 0, 0);
      out.push({
        id: uid('timg'),
        name: `${ci + 1}`,
        dataUrl: tcv.toDataURL('image/png'),
      });
    });
    return { tiles: out, bg: foundBg, hasAlpha };
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

type Tool = 'select' | 'tile' | 'cell' | 'link' | 'hop' | 'erase' | 'pan';

const TOOLS: { key: Tool; label: string; hint: string }[] = [
  { key: 'select', label: 'Выбор', hint: 'клик — выбрать тайл/ячейку и тянуть мышью · пустое место — двигать камеру' },
  { key: 'tile', label: 'Тайл', hint: 'клик — поставить выбранный тайл; можно тянуть с зажатой кнопкой' },
  { key: 'cell', label: 'Ячейка', hint: 'клик — новая ячейка В ЛЮБОМ МЕСТЕ (без привязки к сетке), клик по ячейке — выбрать' },
  { key: 'link', label: 'Стрелка', hint: 'клик по ячейке А, затем по Б. У БЕЗНОМЕРНОЙ ячейки стрелка — куда шагает фишка; у ПРОНУМЕРОВАННОЙ — прыжок при остановке. Клик по той же ячейке — убрать' },
  { key: 'hop', label: 'Переход', hint: 'ВТОРАЯ стрелка: клик по ячейке А, затем по Б — когда фишка ОСТАНОВИТСЯ на А, она прыгнет на Б (выход из круга, штраф-телепорт). Клик по той же ячейке — убрать' },
  { key: 'erase', label: 'Ластик', hint: 'клик или протяни с зажатой кнопкой — убирает ТАЙЛЫ под курсором. Ячейки ластик не трогает: выдели ячейку и нажми Delete' },
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

export default function MapEditor() {
  const { maps, tiles, tokens, setScreen, refresh, toast } = useApp();
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
  const [extract, setExtract] = useState<{ file: File; src: string; name: string; busy: boolean; bgMode: 'auto' | 'custom'; bg: string; foundBg: string; thr: number; minSize: number; mergeGap: number; keepText: boolean; tiles: TileImg[] } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLInputElement>(null);
  const extRef = useRef<HTMLInputElement>(null);
  const ghostRef = useRef<HTMLImageElement | null>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const mapRef = useRef(map); mapRef.current = map;
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const objDragRef = useRef<{ kind: 'cell' | 'stamp'; idx: number; dx: number; dy: number; moved: boolean } | null>(null);
  const resizeRef = useRef<{ idx: number } | null>(null); // ресайз тайла за уголок
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const lastPlaceRef = useRef<{ x: number; y: number } | null>(null);
  const lastCellSize = useRef({ w: CELL, h: CELL }); // размер новых ячеек (запоминается при изменении)
  const lastEraseSfxRef = useRef(0);
  const dirtyRef = useRef(false);
  const toolRef = useRef(tool); toolRef.current = tool;
  const snapRef = useRef(snap); snapRef.current = snap;

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

  /* ---------- фишки партии: отмечаем до 6 фишек из библиотеки — они вшиваются в карту
     и уезжают всем игрокам; после жеребьёвки каждый выберет себе одну (одинаковые нельзя) ---------- */
  const toggleMapToken = (t: TokenDef) => {
    if (!map) return;
    const cur = map.mapTokens ?? [];
    if (cur.some((x) => x.id === t.id)) {
      updMap({ mapTokens: cur.filter((x) => x.id !== t.id) });
      sfx.click();
    } else {
      if (cur.length >= 6) { toast('Максимум 6 фишек на карту — снимите галочку с другой', 'err'); sfx.fail(); return; }
      updMap({ mapTokens: [...cur, { id: t.id, name: t.name, dataUrl: t.dataUrl, createdAt: t.createdAt }] });
      sfx.coin();
    }
    dirtyRef.current = true;
  };
  const updCell = (idx: number, patch: Partial<CellDef>) =>
    setMap((m) => {
      if (!m || !m.cells[idx]) return m;
      const cells = m.cells.slice();
      cells[idx] = { ...cells[idx], ...patch };
      // номера — по порядку создания, стрелки/метки на них не влияют — перенумерация не нужна
      return { ...m, cells } as GameMap;
    });
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
    setLinkFrom(null);
    setTool('select');
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

  const delTile = (tid: string) => {
    if (!map) return;
    const stamps = (map.stamps ?? []).filter((s) => s.tid !== tid);
    updMap({
      tileset: (map.tileset ?? []).filter((t) => t.id !== tid),
      tileGroups: (map.tileGroups ?? []).map((g) => ({ ...g, tids: g.tids.filter((x) => x !== tid) })),
      stamps,
    });
    if (tileId === tid) setTileId('');
    sfx.fail();
  };

  const setBg = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !map) return;
    const r = await importImage(f, 2000, true);
    if (!r) { toast('Это не картинка', 'err'); return; }
    updMap({ bg: r.url, bgMode: 'stretch' });
    sfx.coin();
    toast('Фон карты загружен', 'ok');
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
      const st: Stamp = { id: uid('st'), tid: tileId, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(natW * k), h: Math.round(natH * k), rot: 0 };
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

  const deleteCell = (idx: number) => {
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
    // ресайз тайла за жёлтый уголок — работает в «Выборе» и «Тайле»
    if ((tool === 'select' || tool === 'tile') && selStamp) {
      const si = (m.stamps ?? []).findIndex((s) => s.id === selStamp);
      if (si >= 0) {
        const s = m.stamps![si];
        const rot = s.rot % 2 === 1;
        const vw = rot ? s.h : s.w, vh = rot ? s.w : s.h;
        const grab = 11 / viewRef.current.zoom;
        const cs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (const [ox, oy] of cs) {
          if (Math.abs(w.x - (s.x + (ox * vw) / 2)) <= grab && Math.abs(w.y - (s.y + (oy * vh) / 2)) <= grab) {
            resizeRef.current = { idx: si };
            return;
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
    if (tool === 'erase') {
      const si = stampAtPoint(m, w.x, w.y);
      if (si >= 0) {
        setMap((mm) => (mm ? { ...mm, stamps: (mm.stamps ?? []).filter((_, i) => i !== si) } : mm));
        if (selStamp === (mapRef.current?.stamps ?? [])[si]?.id) setSelStamp(null);
        dirtyRef.current = true;
        lastEraseSfxRef.current = Date.now();
        sfx.fail();
      }
      return;
    }
  };

  /* стереть верхний тайл под точкой (для ластика) */
  const eraseAt = (m: GameMap, wx: number, wy: number) => {
    const si = stampAtPoint(m, wx, wy);
    if (si < 0) return false;
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
      return;
    }
    if (objDragRef.current) {
      const od = objDragRef.current;
      const p = snapPt(w.x - od.dx, w.y - od.dy);
      od.moved = true;
      dirtyRef.current = true;
      if (od.kind === 'cell') updCell(od.idx, { cx: Math.round(p.x), cy: Math.round(p.y) });
      else updStamp(od.idx, { x: Math.round(p.x), y: Math.round(p.y) });
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
      if (e.key === 'Escape') { setLinkFrom(null); setSelCell(null); setSelStamp(null); return; }
      if (!map) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selStamp && selStampIdx >= 0) {
          setMap((mm) => (mm ? { ...mm, stamps: (mm.stamps ?? []).filter((s) => s.id !== selStamp) } : mm));
          setSelStamp(null);
          dirtyRef.current = true;
          sfx.fail();
        } else if (selCell !== null) {
          deleteCell(selCell);
        }
        return;
      }
      if (e.key.toLowerCase() === 'r' && selStamp && selStampIdx >= 0) {
        updStamp(selStampIdx, { rot: ((map.stamps?.[selStampIdx].rot ?? 0) + 1) % 4 });
        dirtyRef.current = true;
        sfx.hover();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selCell, selStamp, selStampIdx]);

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
  }, [legacyTileById, showGrid, selCell, selStamp, selStampIdx, linkFrom, hoverW, tileId]);

  /* ─── панели ─── */
  const saveMap = async () => {
    if (!map) return;
    await persist(map);
    toast('Карта сохранена', 'ok');
  };

  const finish = async () => {
    if (!map) return;
    const starts = map.cells.filter((c) => c.type === 'start').length;
    if (map.cells.length < 10) {
      sfx.fail();
      toast(`Нужно минимум 10 ячеек (сейчас ${map.cells.length})`, 'err');
      return;
    }
    if (starts === 0) {
      sfx.fail();
      toast('Поставьте стартовую ячейку: выберите ячейку и задайте тип «Старт» — с неё начнут все игроки', 'err');
      return;
    }
    if (starts > 1) {
      sfx.fail();
      toast('Стартовая ячейка должна быть ОДНА — лишние переключите в другой тип', 'err');
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
    await idbDel('maps', id);
    await refresh();
    if (map?.id === id) setMap(null);
    toast('Карта удалена', 'err');
  };

  const resizeField = (axis: 'mw' | 'mh', v: number) => updMap({ [axis]: v } as Partial<GameMap>);

  const selCellDef = map && selCell !== null && selCell < map.cells.length ? map.cells[selCell] : null;
  const selStampDef = map && selStampIdx >= 0 ? map.stamps![selStampIdx] : null;
  const selTileDef = tileImgById.get(selStampDef?.tid ?? '');
  const startsCount = map?.cells.filter((c) => c.type === 'start').length ?? 0;
  const taskCells = map?.cells.filter((c) => c.type === 'task').length ?? 0;
  const noTask = map?.cells.filter((c) => c.type === 'task' && !c.task).length ?? 0;
  const restCells = map?.cells.filter((c) => c.type === 'rest').length ?? 0;
  const msz = map ? mapSize(map) : { w: 0, h: 0 };

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
                  <button
                    onClick={() => void removeMap(m.id)}
                    className="px-2 text-faint hover:text-coral cursor-pointer"
                    title="Удалить карту"
                  >{Ic.cross(12)}</button>
                </div>
              ))}
              {maps.length === 0 && <div className="text-[11px] text-faint">Пока пусто — создайте первую карту</div>}
            </div>
          </div>

          {map && (
            <>
              <div>
                <div className="tick-label mb-2">Общий фон карты</div>
                {map.bg ? (
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
                <p className="text-[10px] text-faint mt-1 leading-tight">Фон лежит ВНУТРИ карты и уедет игрокам сам. Большая картинка сожмётся до 2000px.</p>
              </div>

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
                        <button
                          onClick={() => delGroup(g)}
                          title="Убрать группу из панели (папку на компьютере это не трогает)"
                          className="text-faint hover:text-coral cursor-pointer shrink-0 px-0.5"
                        >{Ic.cross(10)}</button>
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
                              <span
                                role="button"
                                aria-label="удалить тайл"
                                onClick={(ev) => { ev.stopPropagation(); delTile(t.id); }}
                                className="absolute top-0 right-0 w-4 h-4 bg-coral text-abyss font-pixel text-[8px] flex items-center justify-center opacity-0 hover:opacity-100 cursor-pointer"
                                style={{ opacity: tileId === t.id ? 0.9 : undefined }}
                              >×</span>
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
                <div className="tick-label mb-2">Размер поля (px)</div>
                <div className="flex flex-wrap gap-1 mb-2">
                  {SIZE_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => { updMap({ mw: p.w, mh: p.h }); sfx.hover(); }}
                      className={`px-2 py-1 text-[9px] font-pixel border-2 cursor-pointer ${msz.w === p.w && msz.h === p.h ? 'border-gold text-gold' : 'border-edge text-faint hover:text-dim'}`}
                    >{p.label}</button>
                  ))}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Ширина</span><Stepper value={msz.w} onChange={(v) => resizeField('mw', v)} min={640} max={4096} step={160} /></div>
                  <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Высота</span><Stepper value={msz.h} onChange={(v) => resizeField('mh', v)} min={640} max={4096} step={160} /></div>
                </div>
              </div>

              <div>
                <div className="tick-label mb-2">Ресурсы игроков</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Минут у каждого</span><Stepper value={map.startMin ?? 60} onChange={(v) => updMap({ startMin: v })} min={5} max={180} step={5} /></div>
                  <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Попыток у каждого</span><Stepper value={map.startTries ?? 60} onChange={(v) => updMap({ startTries: v })} min={5} max={180} step={5} /></div>
                </div>
              </div>

              <div>
                <button
                  onClick={() => setTokOpen((v) => !v)}
                  className="flex items-center gap-1 w-full text-left mb-2 cursor-pointer hover:bg-[rgba(90,169,255,0.08)] px-1 py-0.5"
                  title={tokOpen ? 'Свернуть' : 'Развернуть'}
                >
                  <span className={`text-[10px] shrink-0 ${tokOpen ? 'text-gold' : 'text-faint'}`}>{tokOpen ? '▾' : '▸'}</span>
                  <span className="tick-label">Фишки партии · {(map.mapTokens ?? []).length}/6</span>
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
                      <p className="text-[10px] text-faint leading-tight">Фишек пока нет — нарисуйте или загрузите их в «Редакторе фишек» (главное меню), затем вернитесь сюда.</p>
                    )}
                    <p className="text-[10px] text-faint mt-1.5 leading-tight">Отмеченные фишки вшиваются в карту и уезжают всем игрокам. После жеребьёвки каждый игрок выберет себе одну — одинаковые брать нельзя. Максимум 6.</p>
                  </div>
                )}
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
                  Ячейки: {map.cells.length} / мин. 10 · стартовых: {startsCount} / нужна 1
                </div>
                <div className="text-dim">
                  Задания: {taskCells}{noTask > 0 ? <span className="text-magma"> (без рома: {noTask})</span> : ''}{restCells > 0 ? <span className="text-sky"> · передышек: {restCells}</span> : ''} · Тайлов: {(map.stamps ?? []).length} · {msz.w}×{msz.h}
                </div>
                {tool === 'link' && <div className="text-gold font-pixel text-[8px]">СТРЕЛКА: клик по ячейке А, затем по Б · Esc — отмена{linkFrom !== null ? ' · выбрана А, жмите Б' : ''}</div>}
                {tool === 'hop' && <div className="text-coral font-pixel text-[8px]">ПЕРЕХОД: клик по ячейке А, затем по Б — при остановке на А фишка прыгнет на Б · Esc — отмена{linkFrom !== null ? ' · выбрана А, жмите Б' : ''}</div>}
                {tool === 'erase' && <div className="text-coral font-pixel text-[8px]">ЛАСТИК: клик или тяните с кнопкой — стирает ТАЙЛЫ под курсором · ячейки не трогает</div>}
              </div>
              <div className="absolute bottom-3 right-3 tick-label text-faint text-right pointer-events-none">
                колесо — зум · ПКМ — камера · Delete — удалить · R — поворот · жёлтый угол тайла — размер
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
                    <div className="grid grid-cols-6 gap-1">
                      {CELL_TYPES.map((t) => (
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
                        <p className="text-[9.5px] text-faint leading-tight">Стрелка по умолчанию ЖИРНАЯ (6px) с остриём — сразу видно, куда пойдёт фишка.</p>
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
                        <p className="text-[9.5px] text-faint leading-tight">ПЕРЕХОД по умолчанию ЖИРНЫЙ (6px) с остриём — видно, куда прыгнет фишка.</p>
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

                  <button
                    onClick={() => deleteCell(selCell)}
                    className="w-full py-1.5 border-2 border-coral/60 text-coral font-display text-[10px] uppercase hover:bg-coral/10 transition-colors cursor-pointer"
                  >
                    Удалить ячейку
                  </button>
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
                    <GhostBtn small onClick={() => {
                      const copy: Stamp = { ...selStampDef, id: uid('st'), x: selStampDef.x + 16, y: selStampDef.y + 16 };
                      setMap((mm) => (mm ? { ...mm, stamps: [...(mm.stamps ?? []), copy] } : mm));
                      setSelStamp(copy.id);
                      dirtyRef.current = true;
                      sfx.hover();
                    }}>Дублировать</GhostBtn>
                    <GhostBtn small onClick={() => {
                      const st = map!.stamps!;
                      if (selStampIdx >= st.length - 1) return;
                      const arr = st.slice();
                      [arr[selStampIdx], arr[selStampIdx + 1]] = [arr[selStampIdx + 1], arr[selStampIdx]];
                      updMap({ stamps: arr });
                      dirtyRef.current = true;
                    }} title="Выше по слоям (перекрывает соседей)">Слой +</GhostBtn>
                    <GhostBtn small onClick={() => {
                      const st = map!.stamps!;
                      if (selStampIdx <= 0) return;
                      const arr = st.slice();
                      [arr[selStampIdx], arr[selStampIdx - 1]] = [arr[selStampIdx - 1], arr[selStampIdx]];
                      updMap({ stamps: arr });
                      dirtyRef.current = true;
                    }} title="Ниже по слоям (под соседями)">Слой −</GhostBtn>
                  </div>

                  <button
                    onClick={() => {
                      setMap((mm) => (mm ? { ...mm, stamps: (mm.stamps ?? []).filter((s) => s.id !== selStampDef.id) } : mm));
                      setSelStamp(null);
                      dirtyRef.current = true;
                      sfx.fail();
                    }}
                    className="w-full py-1.5 border-2 border-coral/60 text-coral font-display text-[10px] uppercase hover:bg-coral/10 transition-colors cursor-pointer"
                  >
                    Удалить тайл
                  </button>
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

