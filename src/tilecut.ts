import type { TileImg } from './types';
import { uid } from './db';

/* ---------- ЭКСТРАКТОР ТАЙЛОВ: нарезка спрайт-листов с однотонным фоном ----------
   Общий модуль: используется в редакторе карт И в редакторе анимаций и фишек.
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

export async function extractTilesFromImage(file: File, p: ExtractParams, infoRef?: { current: ExtractInfo | null }): Promise<{ tiles: TileImg[]; bg: string; hasAlpha: boolean }> {
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
