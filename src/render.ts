import type { AnimClip, CellDef, GameMap, TileDef, TileImg, TokenAnim, TokenDir } from './types';
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

/* ---------- Скорость хода фишек ----------
   Скорость задаёт АВТОР КАРТЫ в «клетках в секунду» (GameMap.moveSpeed, 0.5..6),
   одна на все фишки карты; нет значения — спокойный дефолт 1.2 кл/с. */

export const DEF_MOVE_SPEED = 1.2;
export const clampMoveSpeed = (v: number) => Math.min(6, Math.max(0.5, v));

/* ПЛАВНЫЙ режим: ПОСТОЯННАЯ скорость по всему пути → px за кадр 60fps.
   Скорость считается от РАЗМЕРА КЛЕТКИ (CELL), а не от расстояния до первой клетки:
   раньше она мерилась по seg0 (текущая позиция → первая клетка пути) и «плавала»
   от хода к ходу — теперь ход длится ровно столько, сколько задал автор карты. */
export const smoothPxPerFrame = (seg0: number, cps: number) => {
  const s = clampMoveSpeed(cps);
  return Math.min(60, Math.max(0.1, (seg0 * s) / 60));
};

/* ПРЫЖКОВЫЙ режим: коэффициент подхода к цели за кадр — фишка закрывает 95% клетки
   за 1/cps секунд, затем клетка «щёлкается» (как раньше, но скорость из карты). */
export const jumpFrameFactor = (cps: number) => Math.min(0.5, 1 - Math.pow(0.05, clampMoveSpeed(cps) / 60));


/* РАЗМЕЩЁННАЯ АНИМАЦИЯ под точкой: верхняя — та, что позже в массиве */
export function animAtPoint(map: GameMap, wx: number, wy: number): number {
  const an = map.anims ?? [];
  for (let i = an.length - 1; i >= 0; i--) {
    const a = an[i];
    if (wx >= a.x - a.w / 2 && wx < a.x + a.w / 2 && wy >= a.y - a.h / 2 && wy < a.y + a.h / 2) return i;
  }
  return -1;
}

/* Размещённый босс под точкой: верхний — тот, что позже в массиве */
export function bossAtPoint(map: GameMap, wx: number, wy: number): number {
  const bs = map.bosses ?? [];
  for (let i = bs.length - 1; i >= 0; i--) {
    const b = bs[i];
    if (wx >= b.x - b.w / 2 && wx < b.x + b.w / 2 && wy >= b.y - b.h / 2 && wy < b.y + b.h / 2) return i;
  }
  return -1;
}

/* Текущий кадр клипа анимации по времени (мс): кадр = floor(секунды × fps) по кругу */
export function clipFrameIdx(clip: AnimClip, timeMs: number): number {
  const n = clip.frames.length;
  if (!n) return 0;
  const fps = Math.max(1, Math.min(24, clip.fps || 6));
  return Math.floor((timeMs / 1000) * fps) % n;
}

/* Выбор клипа анимированной фишки: при движении — клип направления (нет — idle), на месте — idle */
export function clipForToken(anim: TokenAnim, dir: TokenDir | undefined): AnimClip {
  if (dir) {
    const c = anim[dir];
    if (c && c.frames.length) return c;
  }
  return anim.idle;
}

/* ШТАМП под точкой: верхний — самый высокий СЛОЙ, в нём — позже по массиву */
export function stampAtPoint(map: GameMap, wx: number, wy: number): number {
  const order = stampsDrawOrder(map); // от нижних к верхним
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]; // ищем начиная с САМОГО ВЕРХНЕГО (верхний слой, в нём — позже по массиву)
    const s = (map.stamps ?? [])[i];
    if (!s) continue;
    if (wx >= s.x - s.w / 2 && wx < s.x + s.w / 2 && wy >= s.y - s.h / 2 && wy < s.y + s.h / 2) return i;
  }
  return -1;
}

/* ПОРЯДОК ОТРИСОВКИ ШТАМПОВ: по слоям снизу вверх (layer, нет = 0), внутри слоя —
   порядок в массиве (позже = выше). Возвращает ИНДЕКСЫ в map.stamps.
   Фон карты всегда ниже всех, ячейки/стрелки — выше всех (они рисуются позже в drawBoard). */
export function stampsDrawOrder(map: GameMap): number[] {
  const st = map.stamps ?? [];
  return st
    .map((s, i) => ({ l: s.layer ?? 0, i }))
    .sort((a, b) => (a.l !== b.l ? a.l - b.l : a.i - b.i))
    .map((x) => x.i);
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
  return { x: b.w / 2, y: b.h / 2, zoom: Math.max(0.08, zoom) }; // 0.08 — большие карты (до 16384px) влезают целиком
}

export interface TokenDraw {
  x: number; y: number;
  color: string;
  active: boolean;
  alive: boolean;
  label: string;
  img?: string | null; // dataUrl кастомной фишки (PNG с прозрачностью); у анимированной — превью-кадр idle
  anim?: TokenAnim;    // анимированная фишка: играет кадры клипа по направлению/idle
  dir?: TokenDir;      // текущее направление движения (нет — стоит на месте → idle)
  mv?: boolean;        // фишка ИДЁТ сейчас (влияет на выбор клипа анимации; покачивания у фишки больше нет — убрано по просьбе пользователя)
  phase?: number;      // сдвиг фазы проигрывания (чтобы фишки не мигали синхронно)
  size?: number;       // размер на поле в px по большей стороне (нет: анимированная 64, обычная 34)
  override?: AnimClip;  // разовый клип fx (победа/поражение) — играется ОДИН раз вместо обычного
  overrideStart?: number; // старт клипа override в мс rAF-часов (performance.now)
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
  sndRadii?: boolean; // пунктирные круги радиуса звука у анимаций со звуком (только редактор карт; в игре не рисуем)
  broken?: Record<number, { left: number }>; // разбитые ячейки: трещины + счётчик ходов до восстановления
  brokenAt?: Record<number, number>; // ЛОКАЛЬНЫЙ момент появления разбития (Date.now() клиента) — короткая анимация разлёта осколков после разбития
  bossDown?: Record<string, boolean>; // повержённые боссы: статичный кадр побеждённого
  /* разовые реакции боссов (fx): клип играется ОДИН раз от start (rAF-мс), дойдя до последнего кадра — замирает */
  bossFx?: Record<string, { frames: string[]; fps: number; start: number }>;
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
const REST = ['11111', '...1.', '..1..', '.1...', '11111']; // буква Z — «передышка»
const BOX = ['11111', '1...1', '11111', '.1.1.', '11111']; // лутбокс RUBG
const PLANE = ['...1...', '..111..', '1111111', '..111..', '..1.1..']; // схематичный самолёт (вид сверху)
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

  // СВОИ ФОНЫ КАРТ-ПЛИТОК (плиточный режим карт): у каждой карты-плитки своя
  // «локация». Рисуется ПОВЕРХ общего фона карты, ТОЛЬКО в пределах своей плитки.
  if (map.tileGrid && map.tileBgs) {
    const tg = map.tileGrid;
    for (const t of tg.tiles) {
      const pb = map.tileBgs[t.id];
      if (!pb || !pb.bg) continue;
      const img = getImage(pb.bg);
      if (!img) continue;
      const px = t.col * tg.w, py = t.row * tg.h;
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, tg.w, tg.h);
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      if (pb.bgMode === 'real') ctx.drawImage(img, px, py);
      else ctx.drawImage(img, px, py, tg.w, tg.h);
      ctx.restore();
    }
  }

  // СВОИ ФОНЫ ПЛИТОК: у каждой плитки может быть своя картинка («другая локация»).
  // Рисуется ПОВЕРХ общего фона карты, ТОЛЬКО в пределах своей плитки.
  if (map.plateSize && map.plateBgs) {
    const ps = map.plateSize;
    const cols = Math.ceil(b.w / ps);
    const rows = Math.ceil(b.h / ps);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pb = map.plateBgs[r * cols + c + 1]; // ключ — номер плитки как в навигаторе (с 1)
        if (!pb || !pb.bg) continue;
        const img = getImage(pb.bg);
        if (!img) continue;
        const px = c * ps, py = r * ps;
        const pw = Math.min(ps, b.w - px), ph = Math.min(ps, b.h - py); // краевая плитка может быть неполной
        ctx.save();
        ctx.beginPath();
        ctx.rect(px, py, pw, ph);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        if (pb.bgMode === 'real') ctx.drawImage(img, px, py);
        else ctx.drawImage(img, px, py, pw, ph);
        ctx.restore();
      }
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

  // ШТАМПЫ (тайлы редактора в стиле Tiled): сначала СЛОЙ (layer снизу вверх), внутри слоя — порядок в массиве (последние сверху)
  const tset = tilesetMap(map);
  const stamps = map.stamps ?? [];
  for (const si of stampsDrawOrder(map)) {
    const st = stamps[si];
    if (!st) continue;
    const t = tset.get(st.tid);
    const img = t ? getImage(t.dataUrl) : null;
    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate((st.rot * Math.PI) / 2);
    if (st.flip) ctx.scale(-1, 1); // ЗЕРКАЛО по горизонтали — для тайлов, нарисованных только в одну сторону
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

  // РАЗМЕЩЁННЫЕ АНИМАЦИИ: поверх тайлов, под ячейками; кадр выбирается по времени
  const alib = new Map((map.animLib ?? []).map((a) => [a.id, a]));
  for (const pa of map.anims ?? []) {
    const entry = alib.get(pa.aid);
    if (!entry || !entry.clip.frames.length) continue;
    // круг радиуса звука — только в редакторе карт: автор видит зону срабатывания
    if (o.sndRadii && entry.snd && pa.r && pa.r > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(pa.x, pa.y, pa.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(46,230,168,0.06)';
      ctx.fill();
      ctx.setLineDash([10, 7]);
      ctx.strokeStyle = 'rgba(46,230,168,0.75)';
      ctx.lineWidth = 2 / Math.max(0.05, view.zoom);
      ctx.stroke();
      ctx.restore();
    }
    const img = getImage(entry.clip.frames[clipFrameIdx(entry.clip, o.time)]);
    if (!img) continue;
    ctx.save();
    ctx.translate(pa.x, pa.y);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, -pa.w / 2, -pa.h / 2, pa.w, pa.h);
    ctx.restore();
  }

  // ПОРТАЛЫ: зоны-телепорты между плитками. Видны и в игре — мягкое пульсирующее
  // сиреневое свечение с воронкой в центре (игроки должны видеть, куда заходят);
  // в редакторе карт поверх рисуются свои, более яркие, с подписями и точками перехода
  for (const pz of map.portals ?? []) {
    if (!pz.w || !pz.h) continue;
    const pulse = 0.5 + 0.5 * Math.sin(o.time / 380 + pz.x * 0.01);
    ctx.save();
    ctx.beginPath();
    ctx.rect(pz.x, pz.y, pz.w, pz.h);
    ctx.fillStyle = `rgba(192,122,255,${(0.07 + 0.07 * pulse).toFixed(3)})`;
    ctx.fill();
    ctx.setLineDash([9, 6]);
    ctx.strokeStyle = `rgba(192,122,255,${(0.45 + 0.35 * pulse).toFixed(3)})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
    // воронка-вихрь в центре зоны (только если зона не крошечная)
    if (pz.w > 30 && pz.h > 30) {
      const cx = pz.x + pz.w / 2, cy = pz.y + pz.h / 2;
      const R = Math.min(pz.w, pz.h) * 0.3;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(o.time / 900);
      ctx.strokeStyle = `rgba(216,180,255,${(0.5 + 0.3 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2;
      for (const rr of [R, R * 0.55]) {
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0.35, Math.PI * 1.45);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(233,220,255,${(0.6 + 0.3 * pulse).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(2, R * 0.14), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
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
  /* наконечники явных стрелок, рисуемые ПОВЕРХ ячеек отдельным проходом (заполняется ниже) */
  const topHeads: { x: number; y: number; ux: number; uy: number; hl: number; hw: number; col: string }[] = [];
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
    /* стрелка: линия + большое остриё на конце. w — толщина (по умолчанию 8 — ЖИРНАЯ,
      до 24), wantHead — остриё (по умолчанию вкл): сразу видно, куда переместится фишка.
      headOnTop — остриё рисуется ПОВЕРХ ячеек отдельным проходом; over — «заходит на
      ячейку» (по умолчанию: конец утоплен в клетку, остриё поверх ячеек) либо «у края» —
      вся стрелка (линия и остриё) останавливается У ГРАНИЦЫ ячейки, не налезая на неё */
    const seg = (ai: number, bi: number, col: string, head: string, dashed: boolean, label?: string, w = 8, wantHead = true, headOnTop = false, over = true) => {
      const a = cellCenter(map, ai);
      const c = cellCenter(map, bi);
      const dx = c.x - a.x, dy = c.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      if (len < 8) return;
      const ux = dx / len, uy = dy / len;
      const ba = cellBox(map, ai);
      const bb = cellBox(map, bi);
      /* дистанция от ЦЕНТРА ячейки до её границы вдоль направления u (для «у края») */
      const borderT = (box: { w: number; h: number }) => {
        const tx = Math.abs(ux) > 1e-6 ? box.w / 2 / Math.abs(ux) : Infinity;
        const ty = Math.abs(uy) > 1e-6 ? box.h / 2 / Math.abs(uy) : Infinity;
        return Math.min(tx, ty);
      };
      const GAP = 3; // зазор между остриём и клеткой в режиме «у края»
      const padA = over ? Math.min(ba.w, ba.h) * 0.32 + 6 : borderT(ba) + GAP;
      const padB = over ? Math.min(bb.w, bb.h) * 0.32 + 6 : borderT(bb) + GAP;
      const sx = a.x + ux * padA, sy = a.y + uy * padA;
      const ex = c.x - ux * padB, ey = c.y - uy * padB;
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      if (dashed) ctx.setLineDash([w * 2.4, w * 1.8]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      if (dashed) ctx.setLineDash([]);
      if (wantHead) {
        const hl = 10 + w * 1.9;  // длина острия растёт с толщиной
        const hw = 5.5 + w * 1.1; // полуширина острия
        if (headOnTop) {
          // откладываем: нарисуем ПОСЛЕ ячеек, поверх них — остриё никогда не прячется
          topHeads.push({ x: ex, y: ey, ux, uy, hl, hw, col: head });
        } else {
          ctx.fillStyle = head;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ux * hl - uy * hw, ey - uy * hl + ux * hw);
          ctx.lineTo(ex - ux * hl + uy * hw, ey - uy * hl - ux * hw);
          ctx.fill();
        }
      }
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
        const nst = ci.nextStyle;
        const col = nst?.col ?? (st ? st.c : GOLD);
        seg(i, nxt, col, nst?.col ?? (st ? st.h : GOLD_H), nst?.dash ?? false, st ? st.label : undefined, nst?.w ?? 8, nst?.head ?? true, true, nst?.over ?? true);
      } else if (!isNoNum(ci)) {
        seg(i, (i + 1) % N, AUTO, AUTO_H, true, undefined, 3, true); // авто-порядок у пронумерованных (тонкий белый пунктир)
      }
      const h = ci.hop;
      const hs = ci.hopStyle;
      if (h !== undefined && h >= 0 && h < N && h !== i) seg(i, h, hs?.col ?? HOP, hs?.col ?? HOP_H, hs?.dash ?? false, 'ПЕРЕХОД', hs?.w ?? 8, hs?.head ?? true, true, hs?.over ?? true);
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
      : cell.type === 'bonus' ? '#0d3f2e' : cell.type === 'trap' ? '#43101c' : cell.type === 'rest' ? '#1a2032' : cell.type === 'loot' ? '#4a2a08' : '#232741';
    const edge = cell.color || (isStart ? '#ffcf3f'
      : cell.type === 'bonus' ? '#2ee6a8' : cell.type === 'trap' ? '#ff5d73' : cell.type === 'rest' ? '#7c86b8' : cell.type === 'loot' ? '#ff8b3f' : '#8f97c9');
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
        const icon = cell.type === 'bonus' ? STAR : cell.type === 'trap' ? SKULL : cell.type === 'rest' ? REST : cell.type === 'loot' ? BOX : QUIZ;
        const iconColor = cell.type === 'bonus' ? '#2ee6a8' : cell.type === 'trap' ? '#ff5d73' : cell.type === 'rest' ? '#7c86b8' : cell.type === 'loot' ? '#ff8b3f' : '#5aa9ff';
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
        const name = cell.label || (cell.type === 'bonus' ? 'БОНУС' : cell.type === 'trap' ? 'ЛОВУШКА' : cell.type === 'rest' ? 'ОТДЫХ' : cell.type === 'loot' ? 'ЯЩИК' : 'КВИЗ');
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
        const icon = cell.type === 'bonus' ? STAR : cell.type === 'trap' ? SKULL : cell.type === 'quiz' ? QUIZ : cell.type === 'rest' ? REST : cell.type === 'loot' ? BOX : PAD;
        const iconColor = cell.type === 'task' ? '#ffcf3f' : cell.type === 'quiz' ? '#5aa9ff' : cell.type === 'rest' ? '#7c86b8' : cell.type === 'loot' ? '#ff8b3f' : edge;
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
    /* РАЗБИТАЯ ЯЧЕЙКА: трещины, затемнение и счётчик ходов до восстановления.
       Только что разбитая (brokenAt < 700 мс назад) — короткий спектакль: вспышка,
       разлёт осколков и проявляющиеся трещины. */
    const brk = o.broken?.[i];
    if (brk) {
      const bAt = o.brokenAt?.[i];
      const shatterP = bAt ? Math.min(1, (Date.now() - bAt) / 700) : 1; // 0 — только разбили, 1 — спектакль закончен
      ctx.save();
      ctx.globalAlpha = 0.55 * shatterP;
      ctx.fillStyle = '#070912';
      ctx.fillRect(-W / 2, -H / 2, W, H);
      if (shatterP < 1) {
        // вспышка в момент разбития
        ctx.globalAlpha = 0.5 * (1 - shatterP);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-W / 2, -H / 2, W, H);
      }
      ctx.globalAlpha = Math.max(0.15, shatterP);
      ctx.strokeStyle = 'rgba(214,222,255,0.75)';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      const crack = (x0: number, y0: number, x1: number, y1: number, k: number) => {
        const mx = (x0 + x1) / 2 + (k * W) / 8;
        const my = (y0 + y1) / 2 - (k * H) / 10;
        ctx.beginPath();
        ctx.moveTo(x0, y0); ctx.lineTo(mx, my); ctx.lineTo(x1, y1);
        ctx.stroke();
      };
      crack(-W / 2, -H / 4, W / 2 + 2, H / 4, 1);   // длинная диагональная
      crack(-W / 2 + W * 0.2, -H / 2, W * 0.05, H / 2, -1); // поперечная
      crack(W * 0.15, -H / 2, W / 2 - 2, H / 3, 0.6);
      crack(-W * 0.3, H / 2, -W / 2 + 2, 0, -0.6);
      if (shatterP < 1) {
        // осколки: 8 квадратиков разлетаются от центра с лёгкой дугой и гаснут
        const e = 1 - Math.pow(1 - shatterP, 3); // easeOutCubic
        const cols = ['#ffcf3f', '#e6ecff', '#ff6b5e', '#e6ecff', '#ffcf3f', '#9fb3ff', '#e6ecff', '#ffcf3f'];
        for (let si = 0; si < 8; si++) {
          const ang = (si / 8) * Math.PI * 2 + (i % 7) * 0.35;
          const dist = e * W * (0.42 + (si % 3) * 0.11);
          const sx = Math.cos(ang) * dist;
          const sy = Math.sin(ang) * dist * 0.85 + e * e * W * 0.16; // лёгкая «гравитация»
          const ssz = Math.max(2, 6 * (1 - shatterP * 0.7));
          ctx.globalAlpha = 1 - shatterP;
          ctx.fillStyle = cols[si % cols.length];
          ctx.fillRect(sx - ssz / 2, sy - ssz / 2, ssz, ssz);
        }
      }
      ctx.restore();
      // бейдж «сколько ходов до восстановления» (жёлтый, в правом нижнем углу) — после вспышки
      if (shatterP >= 0.5) {
        ctx.fillStyle = '#ffcf3f';
        ctx.fillRect(W / 2 - 22, H / 2 - 20, 18, 15);
        ctx.fillStyle = '#0a0c18';
        ctx.font = '10px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(Math.max(0, brk.left ?? 0)), W / 2 - 13, H / 2 - 8);
      }
    }
    if (o.hoverCell === i) {
      ctx.strokeStyle = '#ffcf3f';
      ctx.lineWidth = 2;
      ctx.strokeRect(-W / 2 - 6, -H / 2 - 6, W + 12, H + 12);
    }
    ctx.restore();
  }

  // наконечники явных стрелок — ПОВЕРХ ячеек: остриё всегда видно, даже когда клетка
  // крупная или стоит вплотную (раньше остриё закрашивалось ячейкой и терялось)
  for (const th of topHeads) {
    ctx.fillStyle = th.col;
    ctx.beginPath();
    ctx.moveTo(th.x, th.y);
    ctx.lineTo(th.x - th.ux * th.hl - th.uy * th.hw, th.y - th.uy * th.hl + th.ux * th.hw);
    ctx.lineTo(th.x - th.ux * th.hl + th.uy * th.hw, th.y - th.uy * th.hl - th.ux * th.hw);
    ctx.fill();
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

  // БОССЫ: анимации-персонажи на ячейках. Живой — играет idle (или реакцию fx ОДИН раз,
  // включая клип гибели bossDef); повержённый — замер на последнем кадре клипа defeated
  // (у старых боссов без него — на последнем кадре win)
  const blibDraw = new Map((map.bossLib ?? []).map((b) => [b.id, b]));
  for (const pb of map.bosses ?? []) {
    const def = blibDraw.get(pb.bid);
    if (!def) continue;
    // круг радиуса — только в редакторе карт (радиус работает и для реакций, и для звука ожидания)
    if (o.sndRadii && pb.r && pb.r > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(192,122,255,0.06)';
      ctx.fill();
      ctx.setLineDash([10, 7]);
      ctx.strokeStyle = 'rgba(192,122,255,0.8)';
      ctx.lineWidth = 2 / Math.max(0.05, view.zoom);
      ctx.stroke();
      ctx.restore();
    }
    let frames: string[] | null = null;
    let fps = 6;
    let once = false; // клип-одноразка (реакция) — не зацикливать, замереть на последнем кадре
    let startMs = 0;
    const fxC = o.bossFx?.[pb.id];
    if (fxC && fxC.frames.length) {
      frames = fxC.frames; fps = fxC.fps; once = true; startMs = fxC.start;
    } else if (o.bossDown?.[pb.id]) {
      const dclip = def.defeated && def.defeated.frames.length ? def.defeated : def.win;
      frames = dclip.frames.length ? dclip.frames : def.idle.frames;
      fps = dclip.frames.length ? dclip.fps : def.idle.fps;
      once = true; startMs = 0; // статичный кадр — берём последний
    } else {
      frames = def.idle.frames; fps = def.idle.fps;
    }
    if (!frames || !frames.length) continue;
    let idx: number;
    if (once) {
      idx = startMs ? Math.floor(((o.time - startMs) / 1000) * Math.max(1, Math.min(24, fps || 6))) : frames.length - 1;
      idx = Math.max(0, Math.min(frames.length - 1, idx));
    } else {
      idx = clipFrameIdx({ fps, frames }, o.time);
    }
    const img = getImage(frames[idx]);
    if (!img) continue;
    ctx.save();
    ctx.translate(pb.x, pb.y);
    ctx.imageSmoothingEnabled = true;
    if (o.bossDown?.[pb.id] && !fxC) ctx.globalAlpha = 0.85; // побеждённый — чуть приглушён
    ctx.drawImage(img, -pb.w / 2, -pb.h / 2, pb.w, pb.h);
    ctx.restore();
  }

  // токены
  for (let i = 0; i < o.tokens.length; i++) {
    const t = o.tokens[i];
    ctx.save();
    ctx.translate(t.x, t.y);
    /* ПОКАЧИВАНИЕ УБРАНО ПОЛНОСТЬЮ (пользователь: «убрать покачивание и при движении —
       в обоих режимах, плавном и прыжками»): фишка идёт ровно, без синусоиды.
       Постоянный сдвиг -6 — приподнятость над тенью, это не покачивание. */
    ctx.translate(0, -6);
    const s = t.active ? 1.12 : 1;
    ctx.scale(s, s);
    ctx.globalAlpha = t.alive ? 1 : 0.35;
    /* размер фишки задаётся автором фишки (px по большей стороне);
       старые фишки без размера — 34, анимированные без размера — 64 (как тайл на карте) */
    const sz = Math.max(10, Math.min(320, t.size ?? (t.anim ? 64 : 34)));
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(0, sz * 0.47, sz * 0.32, sz * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();

    /* картинка фишки: большая сторона = sz, пропорции сохранены, чуть приподнята над тенью */
    const drawFit = (img: HTMLImageElement) => {
      const iw = img.width || 1, ih = img.height || 1;
      const k = sz / Math.max(iw, ih);
      const dw = iw * k, dh = ih * k;
      ctx.drawImage(img, -dw / 2, -dh / 2 - sz * 0.12, dw, dh);
    };
    const custom = t.img ? getImage(t.img) : null;
    // FX (победа/поражение): разовый клип вместо обычной анимации — от локального старта, замереть на последнем кадре.
    // ВАЖНО: клип рисуется ПЕРВЫМ, а обычная анимация ниже — ТОЛЬКО если клип не отрисовался
    // (раньше idle-кадр рисовался ПОВЕРХ клипа каждый кадр — анимация фишки была не видна).
    let drawn = false;
    if (t.override && t.override.frames.length && t.overrideStart !== undefined) {
      const fpsO = Math.max(1, Math.min(24, t.override.fps || 6));
      const idxO = Math.max(0, Math.min(t.override.frames.length - 1, Math.floor(((o.time - t.overrideStart) / 1000) * fpsO)));
      const fimgO = getImage(t.override.frames[idxO]);
      if (fimgO) {
        ctx.imageSmoothingEnabled = false;
        drawFit(fimgO);
        drawn = true;
      }
    }
    // АНИМИРОВАННАЯ фишка: кадр клипа по направлению (нет — idle); не загрузился — статичное превью.
    // Пока играет разовый fx-клип (override) — обычную анимацию НЕ рисуем.
    const clip = t.anim ? clipForToken(t.anim, t.dir) : null;
    if (!drawn && clip && clip.frames.length) {
      const fimg = getImage(clip.frames[clipFrameIdx(clip, o.time + (t.phase ?? 0) * 1000)]);
      if (fimg) {
        ctx.imageSmoothingEnabled = false;
        drawFit(fimg);
        drawn = true;
      }
    }
    if (!drawn && custom) {
      ctx.imageSmoothingEnabled = false;
      drawFit(custom);
    } else if (!drawn) {
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
    }
    ctx.restore();
  }

  ctx.restore();
}

/* ---------- RUBG: оверлей поверх поля (зона, самолёт, HP-бары) ----------
   Вызывается из игрового экрана сразу после drawBoard — сама ставит ту же
   трансформацию вида. Зона в фазе сжатия интерполируется клиентскими часами. */
export function drawRubgOverlay(
  ctx: CanvasRenderingContext2D,
  opts: {
    view: { x: number; y: number; zoom: number };
    width: number; height: number;
    time: number;
    mapW: number; mapH: number;
    zone: import('./types').RubgZone | null;
    plane: import('./types').RubgPlane | null;
    bars: { x: number; y: number; hp: number; playing: boolean; hidden: boolean }[];
    aim?: { x: number; y: number; r: number } | null; // РАДИУС АТАКИ: круг вокруг моей фишки при выбранном оружии (r — px поля)
    opened?: { x: number; y: number; w: number; h: number }[]; // ВСКРЫТЫЕ ЯЩИКИ: анимированная открытая крышка + подпись «ВСКРЫТ»
    banned?: { x: number; y: number; w: number; h: number }[]; // ЗАКЛИНИВШИЕ ЯЩИКИ (провал «открыть силой»): для этого игрока закрыты навсегда
    shots?: { sx: number; sy: number; tx: number; ty: number; kind: string; ts: number }[]; // ЛЕТЯЩИЕ ПУЛИ (трассеры)
  },
) {
  const { view, width, height } = opts;
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(-view.x, -view.y);

  /* ЗОНА: затемнение вне круга + белая граница текущего + пунктир цели */
  const z = opts.zone;
  if (z) {
    let cx = z.cx, cy = z.cy, r = z.r;
    if (z.phase === 'shrink') {
      const t = Math.max(0, Math.min(1, (Date.now() - z.phaseStart) / Math.max(1, z.phaseEnd - z.phaseStart)));
      cx = z.sx + (z.tx - z.sx) * t;
      cy = z.sy + (z.ty - z.sy) * t;
      r = z.sr + (z.tr - z.sr) * t;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(-60, -60, opts.mapW + 120, opts.mapH + 120);
    ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2, true); // вырез круга — краснеет всё ВОКРУГ
    ctx.fillStyle = 'rgba(120,20,40,0.32)';
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 4;
    ctx.stroke();
    if (z.phase === 'wait' && z.tr < z.r) {
      ctx.beginPath();
      ctx.arc(z.tx, z.ty, Math.max(1, z.tr), 0, Math.PI * 2);
      ctx.setLineDash([14, 10]);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /* САМОЛЁТ (фаза высадки): линия маршрута + схематичный самолёт с тенью */
  const pl = opts.plane;
  if (pl) {
    const now = Date.now();
    const len = Math.hypot(pl.x1 - pl.x0, pl.y1 - pl.y0);
    const d = Math.min(len, Math.max(0, ((now - pl.startAt) / 1000) * pl.speed));
    const fx = pl.x0 + (pl.x1 - pl.x0) * (len ? d / len : 0);
    const fy = pl.y0 + (pl.y1 - pl.y0) * (len ? d / len : 0);
    const ang = Math.atan2(pl.y1 - pl.y0, pl.x1 - pl.x0);
    ctx.save();
    ctx.setLineDash([18, 12]);
    ctx.strokeStyle = 'rgba(255,207,63,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pl.x0, pl.y0);
    ctx.lineTo(pl.x1, pl.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.translate(fx + 14, fy + 22);
    ctx.rotate(ang);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 30, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(fx, fy);
    ctx.rotate(ang);
    ctx.fillStyle = '#e9ecff';
    ctx.beginPath();
    ctx.moveTo(34, 0); ctx.lineTo(-22, -8); ctx.lineTo(-28, 0); ctx.lineTo(-22, 8); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(6, 0); ctx.lineTo(-14, -26); ctx.lineTo(-24, -26); ctx.lineTo(-10, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(6, 0); ctx.lineTo(-14, 26); ctx.lineTo(-24, 26); ctx.lineTo(-10, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-24, 0); ctx.lineTo(-32, -13); ctx.lineTo(-36, -13); ctx.lineTo(-30, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-24, 0); ctx.lineTo(-32, 13); ctx.lineTo(-36, 13); ctx.lineTo(-30, 0); ctx.closePath(); ctx.fill();
    const blink = 0.5 + 0.5 * Math.sin(opts.time / 130);
    ctx.fillStyle = `rgba(255,93,115,${(0.35 + 0.65 * blink).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(8, 0, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    /* ТОЧКА ПРЫЖКА: пульсирующий крест-прицел под самолётом — прыжок приземлит
       ИМЕННО сюда (точка под фюзеляжем в момент нажатия «ПРЫГНУТЬ») */
    const pulseR = 15 + 4 * Math.sin(opts.time / 220);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,207,63,0.85)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 6]);
    ctx.beginPath();
    ctx.arc(fx, fy, pulseR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(fx - pulseR - 10, fy); ctx.lineTo(fx + pulseR + 10, fy);
    ctx.moveTo(fx, fy - pulseR - 10); ctx.lineTo(fx, fy + pulseR + 10);
    ctx.stroke();
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,207,63,0.95)';
    ctx.fillText('ПРЫЖОК ЗДЕСЬ', fx, fy + pulseR + 22);
    ctx.restore();
    ctx.restore();
  }

  /* РАДИУС АТАКИ: при выбранном оружии — пунктирный круг вокруг моей фишки
     (магмовый, с лёгкой заливкой) — видно, кого достанет выстрел */
  const aim = opts.aim;
  if (aim && aim.r > 0) {
    const pulse = 0.55 + 0.2 * Math.sin(opts.time / 240);
    ctx.save();
    ctx.beginPath();
    ctx.arc(aim.x, aim.y, aim.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,139,63,${(0.07 + 0.04 * Math.sin(opts.time / 300)).toFixed(3)})`;
    ctx.fill();
    ctx.setLineDash([12, 9]);
    ctx.lineDashOffset = -(opts.time / 40) % 21; // бегущий пунктир — читается как «прицел»
    ctx.strokeStyle = `rgba(255,139,63,${pulse.toFixed(2)})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /* Маркер «играет задание» над фишками (стелс — не рисуем).
     ПОЛОСКУ HP НАД ФИШКОЙ НЕ РИСУЕМ — HP показывается только в верхней панели ресурсов. */
  for (const b of opts.bars) {
    if (b.hidden) continue;
    if (!b.playing) continue;
    ctx.save();
    ctx.translate(b.x, b.y - 32);
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.65 + 0.35 * Math.sin(opts.time / 220);
    ctx.fillText('▶', 0, 0);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ВСКРЫТЫЕ ЯЩИКИ: анимация «ящик открыт» — крышка откинута и покачивается, проём
     пустой и затемнён, сверху подпись «ВСКРЫТ». Рисуется ПОВЕРХ ячейки — сразу видно,
     что лут отсюда уже забрали (закрытый ящик — иконка 📦 на самой ячейке).
     Блёстки убраны: они вводили в заблуждение, будто лут ещё лежит внутри. */
  for (const b of opts.opened ?? []) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const s = Math.min(b.w, b.h) * 0.34;
    ctx.save();
    ctx.translate(cx, cy);
    /* тень-проём */
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-s * 1.05, -s * 0.9, s * 2.1, s * 1.5);
    /* корпус (приглушённый — ящик пустой) */
    ctx.fillStyle = '#4a3410';
    ctx.fillRect(-s, -s * 0.25, s * 2, s * 1.05);
    ctx.fillStyle = '#5f4515';
    ctx.fillRect(-s, -s * 0.25, s * 2, s * 0.22);
    ctx.strokeStyle = '#2c1e06';
    ctx.lineWidth = 2;
    ctx.strokeRect(-s, -s * 0.25, s * 2, s * 1.05);
    /* открытая крышка — откинута назад, чуть покачивается */
    ctx.save();
    ctx.translate(-s, -s * 0.25);
    ctx.rotate(-1.15 + 0.07 * Math.sin(opts.time / 420));
    ctx.fillStyle = '#6d4d1a';
    ctx.fillRect(0, -s * 0.2, s * 2, s * 0.24);
    ctx.strokeStyle = '#2c1e06';
    ctx.strokeRect(0, -s * 0.2, s * 2, s * 0.24);
    ctx.restore();
    /* подпись «ВСКРЫТ» над ящиком */
    ctx.fillStyle = '#35d46f';
    ctx.font = '7px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ВСКРЫТ', 0, -s * 1.05);
    ctx.restore();
  }

  /* ЗАКЛИНИВШИЕ ЯЩИКИ: провал «открыть силой» заклинил замок — этот ящик закрыт для
     игрока НАВСЕГДА (и отмычкой, и силой). Тёмный приглушённый ящик с красным крестом
     и подписью «ЗАКЛИНИЛО». Видит только сам игрок (запрет у каждого свой). */
  for (const b of opts.banned ?? []) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const s = Math.min(b.w, b.h) * 0.34;
    ctx.save();
    ctx.translate(cx, cy);
    /* затемнение-подложка */
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(-s * 1.15, -s * 1.3, s * 2.3, s * 2.2);
    /* корпус (тусклый, серый) */
    ctx.fillStyle = '#3a3d47';
    ctx.fillRect(-s, -s * 0.2, s * 2, s * 1.0);
    ctx.fillStyle = '#4a4e5a';
    ctx.fillRect(-s, -s * 0.2, s * 2, s * 0.2);
    ctx.strokeStyle = '#15161c';
    ctx.lineWidth = 2;
    ctx.strokeRect(-s, -s * 0.2, s * 2, s * 1.0);
    /* замок-накладка по центру */
    ctx.fillStyle = '#5c6172';
    ctx.fillRect(-s * 0.22, -s * 0.05, s * 0.44, s * 0.5);
    ctx.strokeStyle = '#15161c';
    ctx.strokeRect(-s * 0.22, -s * 0.05, s * 0.44, s * 0.5);
    /* красный крест поверх */
    ctx.strokeStyle = '#ff4b3f';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-s * 0.95, -s * 0.85);
    ctx.lineTo(s * 0.95, s * 0.65);
    ctx.moveTo(s * 0.95, -s * 0.85);
    ctx.lineTo(-s * 0.95, s * 0.65);
    ctx.stroke();
    /* подпись «ЗАКЛИНИЛО» над ящиком */
    ctx.fillStyle = '#ff6b5f';
    ctx.font = '7px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ЗАКЛИНИЛО', 0, -s * 1.15);
    ctx.restore();
  }

  /* ЛЕТЯЩИЕ ПУЛИ: трассер от стрелка к цели + дульная вспышка + вспышка попадания.
     Пистолет — одна быстрая пуля; ПП — очередь из трёх с интервалом 70 мс;
     снайперка — толстый длинный трассер на высокой скорости. */
  const NOWMS = Date.now();
  for (const sh of opts.shots ?? []) {
    const K = sh.kind === 'sniper' ? { spd: 1700, w: 3.2, burst: 1, len: 42 }
      : sh.kind === 'smg' ? { spd: 1150, w: 2.0, burst: 3, len: 24 }
        : { spd: 950, w: 2.3, burst: 1, len: 28 };
    const dist = Math.hypot(sh.tx - sh.sx, sh.ty - sh.sy) || 1;
    const flightMs = (dist / K.spd) * 1000;
    const ux = (sh.tx - sh.sx) / dist, uy = (sh.ty - sh.sy) / dist;
    for (let bIdx = 0; bIdx < K.burst; bIdx++) {
      const t0 = sh.ts + bIdx * 70;
      const p = (NOWMS - t0) / flightMs;
      if (p < 0 || p > 1.4) continue;
      if (p <= 1) {
        const bx = sh.sx + (sh.tx - sh.sx) * p, by = sh.sy + (sh.ty - sh.sy) * p;
        const tail = Math.min(1, p * 4 + 0.25);
        ctx.strokeStyle = 'rgba(255,225,120,0.95)';
        ctx.lineWidth = K.w;
        ctx.beginPath();
        ctx.moveTo(bx - ux * K.len * tail, by - uy * K.len * tail);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.fillStyle = '#fff3c4';
        ctx.beginPath();
        ctx.arc(bx, by, K.w * 0.95, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const q = (p - 1) / 0.4; // вспышка попадания ~150 мс после прилёта
        if (q <= 1) {
          ctx.strokeStyle = `rgba(255,200,80,${(1 - q).toFixed(2)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sh.tx, sh.ty, 4 + q * 11, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    /* дульная вспышка у стрелка (первые 90 мс) */
    const mfp = (NOWMS - sh.ts) / 90;
    if (mfp >= 0 && mfp < 1) {
      ctx.fillStyle = `rgba(255,220,120,${(1 - mfp).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(sh.sx + ux * 10, sh.sy + uy * 10, 6.5 - 3.5 * mfp, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
